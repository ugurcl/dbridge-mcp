import type { Driver, ForeignKey, QueryResult, TableSchema } from "./types.js";
import {
  capBytes,
  capRows,
  filterTables,
  isTableAllowed,
  maskRows,
  redactRows,
  sanitizeQuery,
  truncateCells,
  visibleColumns,
  visibleForeignKeys,
  visiblePrimaryKey,
  type SafetyConfig,
} from "../guard.js";

type Rows = { rows: Record<string, unknown>[] };
type Runner = (text: string, params?: unknown[]) => Promise<Rows>;

export interface MySqlClient {
  query(text: string, params?: unknown[]): Promise<Rows>;
  session<T>(fn: (run: Runner) => Promise<T>): Promise<T>;
}

export interface MySqlOptions {
  statementTimeoutMs: number;
  maxCost: number;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export class MySqlDriver implements Driver {
  constructor(
    private readonly client: MySqlClient,
    private readonly safety: SafetyConfig,
    private readonly options: MySqlOptions,
    private readonly closer: () => Promise<void>,
  ) {}

  async listTables(): Promise<string[]> {
    const { rows } = await this.client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_name",
    );
    return filterTables(
      rows.map((row) => String(row.table_name ?? row.TABLE_NAME)),
      this.safety,
    );
  }

  async describeTable(table: string): Promise<TableSchema> {
    if (!isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columnRows = await this.fetchColumns(table);
    if (columnRows.length === 0) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columns = columnRows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
    }));
    return {
      columns: visibleColumns(columns, this.safety),
      primaryKey: visiblePrimaryKey(await this.fetchPrimaryKey(table), this.safety),
      foreignKeys: visibleForeignKeys(await this.fetchForeignKeys(table), this.safety),
      rowCount: await this.estimateRowCount(table),
    };
  }

  async runQuery(sql: string): Promise<QueryResult> {
    const { sql: statement, rowCap } = sanitizeQuery(sql, this.safety);
    const start = Date.now();
    const raw = await this.readOnly(async (run) => {
      await this.enforceCost(run, statement);
      const result = await run(statement);
      return result.rows;
    });
    const elapsedMs = Date.now() - start;
    const capped = capRows(raw, rowCap);
    const shaped = truncateCells(
      maskRows(redactRows(capped.rows, this.safety), this.safety.maskedColumns),
      this.safety.maxCellChars,
    );
    const limited = capBytes(shaped, this.safety.maxResultBytes);
    return {
      rowCount: limited.rows.length,
      truncated: capped.truncated || limited.truncated,
      rows: limited.rows,
      elapsedMs,
    };
  }

  async explainQuery(sql: string): Promise<unknown> {
    const { sql: statement } = sanitizeQuery(sql, this.safety);
    return this.readOnly(async (run) => {
      const { rows } = await run(`EXPLAIN FORMAT=JSON ${statement}`);
      const plan = parsePlan(rows[0]);
      return { totalCost: extractCost(plan), plan };
    });
  }

  async countRows(table: string): Promise<number> {
    if (!isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columns = await this.fetchColumns(table);
    if (columns.length === 0) {
      throw new Error(`Unknown table: ${table}`);
    }
    const rows = await this.readOnly(async (run) => {
      const result = await run(`SELECT count(*) AS count FROM ${quoteIdent(table)}`);
      return result.rows;
    });
    return Number((rows[0] as { count: string | number }).count);
  }

  async close(): Promise<void> {
    await this.closer();
  }

  private async readOnly<T>(fn: (run: Runner) => Promise<T>): Promise<T> {
    return this.client.session(async (run) => {
      if (this.options.statementTimeoutMs > 0) {
        await run(`SET SESSION max_execution_time = ${this.options.statementTimeoutMs}`);
      }
      await run("START TRANSACTION READ ONLY");
      try {
        const result = await fn(run);
        await run("COMMIT");
        return result;
      } catch (error) {
        await run("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  private async enforceCost(run: Runner, statement: string): Promise<void> {
    if (this.options.maxCost <= 0) {
      return;
    }
    const { rows } = await run(`EXPLAIN FORMAT=JSON ${statement}`);
    const cost = extractCost(parsePlan(rows[0]));
    if (cost !== undefined && cost > this.options.maxCost) {
      throw new Error(
        `Query rejected: estimated cost ${Math.round(cost)} exceeds the limit of ${this.options.maxCost}. Narrow the query (add filters or a smaller range).`,
      );
    }
  }

  private async fetchColumns(table: string): Promise<ColumnRow[]> {
    const { rows } = await this.client.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position",
      [table],
    );
    return rows.map((row) => ({
      column_name: String(row.column_name ?? row.COLUMN_NAME),
      data_type: String(row.data_type ?? row.DATA_TYPE),
      is_nullable: String(row.is_nullable ?? row.IS_NULLABLE),
    }));
  }

  private async fetchPrimaryKey(table: string): Promise<string[]> {
    const { rows } = await this.client.query(
      `SELECT column_name FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY'
       ORDER BY ordinal_position`,
      [table],
    );
    return rows.map((row) => String(row.column_name ?? row.COLUMN_NAME));
  }

  private async fetchForeignKeys(table: string): Promise<ForeignKey[]> {
    const { rows } = await this.client.query(
      `SELECT column_name, referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [table],
    );
    return rows.map((row) => ({
      column: String(row.column_name ?? row.COLUMN_NAME),
      referencesTable: String(row.referenced_table_name ?? row.REFERENCED_TABLE_NAME),
      referencesColumn: String(row.referenced_column_name ?? row.REFERENCED_COLUMN_NAME),
    }));
  }

  private async estimateRowCount(table: string): Promise<number | null> {
    const { rows } = await this.client.query(
      "SELECT table_rows FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
      [table],
    );
    if (rows.length === 0) {
      return null;
    }
    const value = Number((rows[0] as { table_rows?: unknown }).table_rows ?? (rows[0] as { TABLE_ROWS?: unknown }).TABLE_ROWS);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
}

function parsePlan(row: unknown): unknown {
  const value = (row as Record<string, unknown>)?.EXPLAIN ?? (row as Record<string, unknown>)?.explain;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function extractCost(plan: unknown): number | undefined {
  const block = (plan as { query_block?: { cost_info?: { query_cost?: string } } })?.query_block;
  const cost = block?.cost_info?.query_cost;
  if (cost === undefined) {
    return undefined;
  }
  const parsed = Number(cost);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}
