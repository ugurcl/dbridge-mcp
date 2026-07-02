import type { Column } from "./drivers/types.js";

export interface SafetyConfig {
  maxRows: number;
  hiddenColumns: string[];
}

export const DEFAULT_SAFETY: SafetyConfig = {
  maxRows: 1000,
  hiddenColumns: [],
};

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|pragma|reindex|truncate|grant|revoke|copy)\b/i;

export function sanitizeQuery(sql: string, config: SafetyConfig): string {
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

  const restricted = config.hiddenColumns.find((column) => containsWord(clean, column));
  if (restricted) {
    throw new Error(`Column "${restricted}" is restricted and cannot be queried.`);
  }

  return hasLimit(clean) ? clean : `${clean} LIMIT ${config.maxRows}`;
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

function toLowerSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function containsWord(text: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLimit(statement: string): boolean {
  return /\blimit\b/i.test(statement);
}
