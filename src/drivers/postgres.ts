import type { Column, Driver, QueryResult } from "./types.js";
import { redactRows, sanitizeQuery, visibleColumns, type SafetyConfig } from "../guard.js";

export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
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
    private readonly closer: () => Promise<void>,
  ) {}

  async listTables(): Promise<string[]> {
    const { rows } = await this.client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    return rows.map((row) => String(row.table_name));
  }

  async describeTable(table: string): Promise<Column[]> {
    const { rows } = await this.client.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
      [table],
    );
    if (rows.length === 0) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columns = (rows as unknown as ColumnRow[]).map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
    }));
    return visibleColumns(columns, this.safety);
  }

  async runQuery(sql: string): Promise<QueryResult> {
    const statement = sanitizeQuery(sql, this.safety);
    const { rows } = await this.client.query(statement);
    const visible = redactRows(rows, this.safety);
    return {
      rowCount: visible.length,
      truncated: visible.length >= this.safety.maxRows,
      rows: visible,
    };
  }

  async close(): Promise<void> {
    await this.closer();
  }
}
