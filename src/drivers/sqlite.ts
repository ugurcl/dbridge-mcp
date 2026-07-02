import { DatabaseSync } from "node:sqlite";
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

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
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

  async describeTable(table: string): Promise<TableSchema> {
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
    const primaryKey = info
      .filter((row) => row.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((row) => row.name);
    const fkRows = this.db
      .prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`)
      .all() as unknown as ForeignKeyRow[];
    const foreignKeys: ForeignKey[] = fkRows.map((row) => ({
      column: row.from,
      referencesTable: row.table,
      referencesColumn: row.to,
    }));
    return {
      columns: visibleColumns(columns, this.safety),
      primaryKey: visiblePrimaryKey(primaryKey, this.safety),
      foreignKeys: visibleForeignKeys(foreignKeys, this.safety),
      rowCount: null,
    };
  }

  async runQuery(sql: string): Promise<QueryResult> {
    const { sql: statement, rowCap } = sanitizeQuery(sql, this.safety);
    const start = Date.now();
    const raw = this.db.prepare(statement).all() as Record<string, unknown>[];
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
