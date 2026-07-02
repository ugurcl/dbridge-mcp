import { readFileSync } from "node:fs";
import type { DriverKind } from "./drivers/index.js";
import { DEFAULT_SAFETY, type SafetyConfig } from "./guard.js";

export interface DriverOptions {
  statementTimeoutMs: number;
  maxPoolSize: number;
  connectionTimeoutMs: number;
  requireSsl: boolean;
  schemas: string[];
  auditLog: boolean;
}

export const DEFAULT_DRIVER_OPTIONS: DriverOptions = {
  statementTimeoutMs: 10000,
  maxPoolSize: 5,
  connectionTimeoutMs: 10000,
  requireSsl: false,
  schemas: ["public"],
  auditLog: false,
};

export interface AppConfig {
  kind: DriverKind;
  connection: string;
  safety: SafetyConfig;
  driver: DriverOptions;
}

interface RawConfig {
  maxRows?: unknown;
  hiddenColumns?: unknown;
  allowedTables?: unknown;
  blockedTables?: unknown;
  statementTimeoutMs?: unknown;
  maxPoolSize?: unknown;
  connectionTimeoutMs?: unknown;
  requireSsl?: unknown;
  schemas?: unknown;
  auditLog?: unknown;
}

export function loadConfig(): AppConfig {
  const connection = process.env.DBRIDGE_DB_PATH ?? process.argv[2];
  if (!connection) {
    throw new Error(
      "No database provided. Set DBRIDGE_DB_PATH or pass a sqlite file path or a postgres:// connection string as the first argument.",
    );
  }
  const raw = loadRaw();
  return {
    kind: detectKind(connection),
    connection,
    safety: parseSafety(raw),
    driver: parseDriver(raw),
  };
}

function loadRaw(): RawConfig {
  const path = process.env.DBRIDGE_CONFIG;
  if (!path) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("DBRIDGE_CONFIG must contain a JSON object.");
  }
  return parsed as RawConfig;
}

function parseSafety(raw: RawConfig): SafetyConfig {
  return {
    maxRows: positiveInt(raw.maxRows, "maxRows", DEFAULT_SAFETY.maxRows),
    hiddenColumns: stringArray(raw.hiddenColumns, "hiddenColumns"),
    allowedTables: stringArray(raw.allowedTables, "allowedTables"),
    blockedTables: stringArray(raw.blockedTables, "blockedTables"),
  };
}

function parseDriver(raw: RawConfig): DriverOptions {
  const schemas = stringArray(raw.schemas, "schemas");
  return {
    statementTimeoutMs: nonNegativeInt(
      raw.statementTimeoutMs,
      "statementTimeoutMs",
      DEFAULT_DRIVER_OPTIONS.statementTimeoutMs,
    ),
    maxPoolSize: positiveInt(raw.maxPoolSize, "maxPoolSize", DEFAULT_DRIVER_OPTIONS.maxPoolSize),
    connectionTimeoutMs: nonNegativeInt(
      raw.connectionTimeoutMs,
      "connectionTimeoutMs",
      DEFAULT_DRIVER_OPTIONS.connectionTimeoutMs,
    ),
    requireSsl: boolValue(raw.requireSsl, "requireSsl", DEFAULT_DRIVER_OPTIONS.requireSsl),
    schemas: schemas.length > 0 ? schemas : DEFAULT_DRIVER_OPTIONS.schemas,
    auditLog:
      boolValue(raw.auditLog, "auditLog", DEFAULT_DRIVER_OPTIONS.auditLog) || envFlag("DBRIDGE_AUDIT_LOG"),
  };
}

function detectKind(connection: string): DriverKind {
  return /^postgres(ql)?:\/\//i.test(connection) ? "postgres" : "sqlite";
}

function positiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function boolValue(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value as string[];
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value === "true" || value === "yes";
}
