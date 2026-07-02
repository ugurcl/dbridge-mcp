import { DatabaseSync } from "node:sqlite";

const MAX_ROWS = 1000;

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|pragma|reindex|truncate|grant|revoke)\b/i;

export function openDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

export function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function describeTable(db: DatabaseSync, table: string): unknown[] {
  if (!listTables(db).includes(table)) {
    throw new Error(`Unknown table: ${table}`);
  }
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
}

export interface QueryResult {
  rowCount: number;
  truncated: boolean;
  rows: unknown[];
}

export function runQuery(db: DatabaseSync, sql: string): QueryResult {
  const statement = normalizeStatement(sql);
  const bounded = hasLimit(statement) ? statement : `${statement} LIMIT ${MAX_ROWS}`;
  const rows = db.prepare(bounded).all();

  return {
    rowCount: rows.length,
    truncated: rows.length >= MAX_ROWS,
    rows,
  };
}

function normalizeStatement(sql: string): string {
  const clean = sql.trim().replace(/;+\s*$/, "");

  if (clean.length === 0) {
    throw new Error("Empty query.");
  }
  if (clean.includes(";")) {
    throw new Error("Only a single statement is allowed.");
  }
  if (!/^(select|with)\b/i.test(clean)) {
    throw new Error("Only SELECT queries are allowed; this bridge is read-only.");
  }
  if (FORBIDDEN.test(clean)) {
    throw new Error("Query contains a forbidden keyword; this bridge is read-only.");
  }

  return clean;
}

function hasLimit(statement: string): boolean {
  return /\blimit\b/i.test(statement);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
