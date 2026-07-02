import type { Column } from "./drivers/types.js";

export interface SafetyConfig {
  maxRows: number;
  hiddenColumns: string[];
  allowedTables: string[];
  blockedTables: string[];
}

export const DEFAULT_SAFETY: SafetyConfig = {
  maxRows: 1000,
  hiddenColumns: [],
  allowedTables: [],
  blockedTables: [],
};

export interface SanitizedQuery {
  sql: string;
  rowCap: number;
}

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|pragma|reindex|truncate|grant|revoke|copy|merge|call|lock)\b/i;

const METADATA =
  /\b(information_schema|sqlite_master|sqlite_schema|sqlite_temp_master|pg_catalog|pg_class|pg_tables|pg_namespace|pg_attribute|pg_database|pg_authid|pg_shadow|pg_user|pg_roles|pg_stat_activity)\b/i;

export function sanitizeQuery(sql: string, config: SafetyConfig): SanitizedQuery {
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
  if (METADATA.test(clean)) {
    throw new Error(
      "System catalogs are not queryable; use list_tables and describe_table to discover the schema.",
    );
  }

  const restricted = config.hiddenColumns.find((column) => containsWord(clean, column));
  if (restricted) {
    throw new Error(`Column "${restricted}" is restricted and cannot be queried.`);
  }

  const blocked = config.blockedTables.find((table) => containsWord(clean, unqualify(table)));
  if (blocked) {
    throw new Error(`Table "${blocked}" is not accessible.`);
  }

  return applyRowCap(clean, config.maxRows);
}

function applyRowCap(clean: string, maxRows: number): SanitizedQuery {
  const match = clean.match(/\blimit\s+(\d+)(\s+offset\s+\d+)?\s*$/i);
  if (!match) {
    return { sql: `${clean} LIMIT ${maxRows + 1}`, rowCap: maxRows };
  }
  const requested = Number(match[1]);
  if (requested <= maxRows) {
    return { sql: clean, rowCap: Infinity };
  }
  const head = clean.slice(0, match.index);
  const offset = match[2] ?? "";
  return { sql: `${head}LIMIT ${maxRows + 1}${offset}`, rowCap: maxRows };
}

export function visibleColumns(columns: Column[], config: SafetyConfig): Column[] {
  if (config.hiddenColumns.length === 0) {
    return columns;
  }
  const hidden = toLowerSet(config.hiddenColumns);
  return columns.filter((column) => !hidden.has(column.name.toLowerCase()));
}

export function redactRows(
  rows: Record<string, unknown>[],
  config: SafetyConfig,
): Record<string, unknown>[] {
  if (config.hiddenColumns.length === 0) {
    return rows;
  }
  const hidden = toLowerSet(config.hiddenColumns);
  return rows.map((row) => {
    const visible: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!hidden.has(key.toLowerCase())) {
        visible[key] = value;
      }
    }
    return visible;
  });
}

export function isTableAllowed(name: string, config: SafetyConfig): boolean {
  const candidates = new Set([name.toLowerCase(), unqualify(name).toLowerCase()]);
  const matches = (list: string[]) =>
    list.some(
      (entry) =>
        candidates.has(entry.toLowerCase()) || candidates.has(unqualify(entry).toLowerCase()),
    );

  if (config.blockedTables.length > 0 && matches(config.blockedTables)) {
    return false;
  }
  if (config.allowedTables.length > 0) {
    return matches(config.allowedTables);
  }
  return true;
}

export function filterTables(names: string[], config: SafetyConfig): string[] {
  return names.filter((name) => isTableAllowed(name, config));
}

export function capRows(
  rows: Record<string, unknown>[],
  rowCap: number,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  if (rows.length > rowCap) {
    return { rows: rows.slice(0, rowCap), truncated: true };
  }
  return { rows, truncated: false };
}

function unqualify(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

function toLowerSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function containsWord(text: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
