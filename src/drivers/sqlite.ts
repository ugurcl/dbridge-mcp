import { DatabaseSync } from "node:sqlite";
import type { Column, Driver, QueryResult } from "./types.js";
import { redactRows, sanitizeQuery, visibleColumns, type SafetyConfig } from "../guard.js";

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
}

export class SqliteDriver implements Driver {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly safety: SafetyConfig,
  ) {
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  async listTables(): Promise<string[]> {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    return rows.map((row) => row.name);
  }

  async describeTable(table: string): Promise<Column[]> {
    const tables = await this.listTables();
    if (!tables.includes(table)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const info = this.db
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all() as unknown as TableInfoRow[];
    const columns = info.map((row) => ({
      name: row.name,
      type: row.type || "unknown",
      nullable: row.notnull === 0,
    }));
    return visibleColumns(columns, this.safety);
  }

  async runQuery(sql: string): Promise<QueryResult> {
    const statement = sanitizeQuery(sql, this.safety);
    const rows = this.db.prepare(statement).all() as Record<string, unknown>[];
    const visible = redactRows(rows, this.safety);
    return {
      rowCount: visible.length,
      truncated: visible.length >= this.safety.maxRows,
      rows: visible,
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
