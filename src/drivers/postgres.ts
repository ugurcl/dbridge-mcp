import type { Column, Driver, QueryResult } from "./types.js";
import {
  capRows,
  filterTables,
  isTableAllowed,
  maskRows,
  redactRows,
  sanitizeQuery,
  visibleColumns,
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

  async describeTable(table: string): Promise<Column[]> {
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
    return visibleColumns(columns, this.safety);
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
    const { rows, truncated } = capRows(raw, rowCap);
    const visible = maskRows(redactRows(rows, this.safety), this.safety.maskedColumns);
    return {
      rowCount: visible.length,
      truncated,
      rows: visible,
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
