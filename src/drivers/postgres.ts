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

export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<Rows>;
  session<T>(fn: (run: Runner) => Promise<T>): Promise<T>;
}

export interface PostgresOptions {
  statementTimeoutMs: number;
  schemas: string[];
  maxCost: number;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export class PostgresDriver implements Driver {
  constructor(
    private readonly client: SqlClient,
    private readonly safety: SafetyConfig,
    private readonly options: PostgresOptions,
    private readonly closer: () => Promise<void>,
  ) {}

  async listTables(): Promise<string[]> {
    const { rows } = await this.client.query(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = ANY($1) AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_schema, table_name",
      [this.options.schemas],
    );
    const qualify = this.options.schemas.length > 1;
    const names = rows.map((row) =>
      qualify ? `${String(row.table_schema)}.${String(row.table_name)}` : String(row.table_name),
    );
    return filterTables(names, this.safety);
  }

  async describeTable(table: string): Promise<TableSchema> {
    if (!isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const rows = await this.fetchColumns(table);
    if (rows.length === 0) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columns = rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
    }));
    const dot = table.indexOf(".");
    const name = dot === -1 ? table : table.slice(dot + 1);
    const schema = dot === -1 ? await this.resolveSchema(name) : table.slice(0, dot);
    return {
      columns: visibleColumns(columns, this.safety),
      primaryKey: visiblePrimaryKey(await this.fetchPrimaryKey(schema, name), this.safety),
      foreignKeys: visibleForeignKeys(await this.fetchForeignKeys(schema, name), this.safety),
      rowCount: await this.estimateRowCount(schema, name),
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
      const { rows } = await run(`EXPLAIN (FORMAT JSON) ${statement}`);
      const plan = (rows[0] as { "QUERY PLAN"?: unknown })["QUERY PLAN"];
      const totalCost = extractCost(plan);
      return { totalCost, plan };
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
      const result = await run(`SELECT count(*)::bigint AS count FROM ${quoteQualified(table)}`);
      return result.rows;
    });
    return Number((rows[0] as { count: string | number }).count);
  }

  async close(): Promise<void> {
    await this.closer();
  }

  private async readOnly<T>(fn: (run: Runner) => Promise<T>): Promise<T> {
    return this.client.session(async (run) => {
      await run("BEGIN TRANSACTION READ ONLY");
      try {
        if (this.options.statementTimeoutMs > 0) {
          await run(`SET LOCAL statement_timeout = ${this.options.statementTimeoutMs}`);
        }
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
    const { rows } = await run(`EXPLAIN (FORMAT JSON) ${statement}`);
    const cost = extractCost((rows[0] as { "QUERY PLAN"?: unknown })["QUERY PLAN"]);
    if (cost !== undefined && cost > this.options.maxCost) {
      throw new Error(
        `Query rejected: estimated cost ${Math.round(cost)} exceeds the limit of ${this.options.maxCost}. Narrow the query (add filters or a smaller range).`,
      );
    }
  }

  private async resolveSchema(name: string): Promise<string> {
    const { rows } = await this.client.query(
      "SELECT table_schema FROM information_schema.tables WHERE table_schema = ANY($1) AND table_name = $2 LIMIT 1",
      [this.options.schemas, name],
    );
    return rows.length > 0 ? String(rows[0].table_schema) : this.options.schemas[0];
  }

  private async fetchPrimaryKey(schema: string, name: string): Promise<string[]> {
    const { rows } = await this.client.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [schema, name],
    );
    return rows.map((row) => String(row.column_name));
  }

  private async fetchForeignKeys(schema: string, name: string): Promise<ForeignKey[]> {
    const { rows } = await this.client.query(
      `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, name],
    );
    return rows.map((row) => ({
      column: String(row.column_name),
      referencesTable: String(row.ref_table),
      referencesColumn: String(row.ref_column),
    }));
  }

  private async estimateRowCount(schema: string, name: string): Promise<number | null> {
    const { rows } = await this.client.query(
      "SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = to_regclass($1)",
      [`${quoteQualified(`${schema}.${name}`)}`],
    );
    if (rows.length === 0) {
      return null;
    }
    const estimate = Number((rows[0] as { estimate: string | number }).estimate);
    return Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
  }

  private async fetchColumns(table: string): Promise<ColumnRow[]> {
    const dot = table.indexOf(".");
    if (dot !== -1) {
      const schema = table.slice(0, dot);
      const name = table.slice(dot + 1);
      const { rows } = await this.client.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
        [schema, name],
      );
      return rows as unknown as ColumnRow[];
    }
    const { rows } = await this.client.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = ANY($1) AND table_name = $2 ORDER BY ordinal_position",
      [this.options.schemas, table],
    );
    return rows as unknown as ColumnRow[];
  }
}

function extractCost(plan: unknown): number | undefined {
  const node = Array.isArray(plan) ? plan[0] : plan;
  if (node && typeof node === "object" && "Plan" in node) {
    const inner = (node as { Plan: { "Total Cost"?: number } }).Plan;
    return typeof inner["Total Cost"] === "number" ? inner["Total Cost"] : undefined;
  }
  return undefined;
}

function quoteQualified(name: string): string {
  return name
    .split(".")
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(".");
}
