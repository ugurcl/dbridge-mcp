import { DatabaseSync } from "node:sqlite";
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
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    return filterTables(
      rows.map((row) => row.name),
      this.safety,
    );
  }

  async describeTable(table: string): Promise<Column[]> {
    if (!isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    if (!rows.some((row) => row.name === table)) {
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
    const { sql: statement, rowCap } = sanitizeQuery(sql, this.safety);
    const start = Date.now();
    const raw = this.db.prepare(statement).all() as Record<string, unknown>[];
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
    const plan = this.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as Record<
      string,
      unknown
    >[];
    return { plan };
  }

  async countRows(table: string): Promise<number> {
    if (!isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const tables = await this.listTables();
    if (!tables.includes(table)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const row = this.db
      .prepare(`SELECT count(*) AS count FROM ${quoteIdent(table)}`)
      .get() as { count: number };
    return Number(row.count);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
