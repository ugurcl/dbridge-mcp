import { readFileSync } from "node:fs";
import type { DriverKind } from "./drivers/index.js";
import { DEFAULT_SAFETY, type SafetyConfig } from "./guard.js";

export interface AppConfig {
  kind: DriverKind;
  connection: string;
  safety: SafetyConfig;
}

export function loadConfig(): AppConfig {
  const connection = process.env.DBRIDGE_DB_PATH ?? process.argv[2];
  if (!connection) {
    throw new Error(
      "No database provided. Set DBRIDGE_DB_PATH or pass a sqlite file path or a postgres:// connection string as the first argument.",
    );
  }
  return {
    kind: detectKind(connection),
    connection,
    safety: loadSafety(),
  };
}

function detectKind(connection: string): DriverKind {
  return /^postgres(ql)?:\/\//i.test(connection) ? "postgres" : "sqlite";
}

function loadSafety(): SafetyConfig {
  const path = process.env.DBRIDGE_CONFIG;
  if (!path) {
    return DEFAULT_SAFETY;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SafetyConfig>;
  return {
    maxRows: raw.maxRows ?? DEFAULT_SAFETY.maxRows,
    hiddenColumns: raw.hiddenColumns ?? DEFAULT_SAFETY.hiddenColumns,
  };
}
