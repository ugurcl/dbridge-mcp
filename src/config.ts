import { readFileSync } from "node:fs";
import type { DriverKind } from "./drivers/index.js";
import { DEFAULT_SAFETY, type MaskSpec, type MaskStrategy, type SafetyConfig } from "./guard.js";

export interface DriverOptions {
  statementTimeoutMs: number;
  maxPoolSize: number;
  connectionTimeoutMs: number;
  requireSsl: boolean;
  schemas: string[];
  auditLog: boolean;
  maxCost: number;
  rateLimitPerMin: number;
}

export const DEFAULT_DRIVER_OPTIONS: DriverOptions = {
  statementTimeoutMs: 10000,
  maxPoolSize: 5,
  connectionTimeoutMs: 10000,
  requireSsl: false,
  schemas: ["public"],
  auditLog: false,
  maxCost: 0,
  rateLimitPerMin: 0,
};

export interface AppConfig {
  kind: DriverKind;
  connection: string;
  safety: SafetyConfig;
  driver: DriverOptions;
}

type FieldType = "posint" | "nonnegint" | "bool" | "list";

interface FieldDef {
  key: string;
  env: string;
  flag: string;
  type: FieldType;
}

const FIELDS: FieldDef[] = [
  { key: "maxRows", env: "DBRIDGE_MAX_ROWS", flag: "max-rows", type: "posint" },
  { key: "hiddenColumns", env: "DBRIDGE_HIDDEN_COLUMNS", flag: "hidden-columns", type: "list" },
  { key: "allowedTables", env: "DBRIDGE_ALLOWED_TABLES", flag: "allowed-tables", type: "list" },
  { key: "blockedTables", env: "DBRIDGE_BLOCKED_TABLES", flag: "blocked-tables", type: "list" },
  { key: "maskedColumns", env: "DBRIDGE_MASKED_COLUMNS", flag: "masked-columns", type: "list" },
  { key: "maxCellChars", env: "DBRIDGE_MAX_CELL_CHARS", flag: "max-cell-chars", type: "nonnegint" },
  {
    key: "maxResultBytes",
    env: "DBRIDGE_MAX_RESULT_BYTES",
    flag: "max-result-bytes",
    type: "nonnegint",
  },
  {
    key: "statementTimeoutMs",
    env: "DBRIDGE_STATEMENT_TIMEOUT_MS",
    flag: "statement-timeout-ms",
    type: "nonnegint",
  },
  { key: "maxPoolSize", env: "DBRIDGE_MAX_POOL_SIZE", flag: "max-pool-size", type: "posint" },
  {
    key: "connectionTimeoutMs",
    env: "DBRIDGE_CONNECTION_TIMEOUT_MS",
    flag: "connection-timeout-ms",
    type: "nonnegint",
  },
  { key: "requireSsl", env: "DBRIDGE_REQUIRE_SSL", flag: "require-ssl", type: "bool" },
  { key: "schemas", env: "DBRIDGE_SCHEMAS", flag: "schemas", type: "list" },
  { key: "auditLog", env: "DBRIDGE_AUDIT_LOG", flag: "audit-log", type: "bool" },
  { key: "maxCost", env: "DBRIDGE_MAX_COST", flag: "max-cost", type: "nonnegint" },
  {
    key: "rateLimitPerMin",
    env: "DBRIDGE_RATE_LIMIT_PER_MIN",
    flag: "rate-limit-per-min",
    type: "nonnegint",
  },
];

type Raw = Record<string, unknown>;

export function loadConfig(argv: string[] = process.argv.slice(2)): AppConfig {
  const { flags, positionals } = parseArgv(argv);
  const connection = process.env.DBRIDGE_DB_PATH ?? positionals[0];
  if (!connection) {
    throw new Error(
      "No database provided. Set DBRIDGE_DB_PATH or pass a sqlite file path or a postgres:// connection string as the first argument.",
    );
  }
  const raw = mergeSources(loadFile(), parseEnv(), flags);
  return {
    kind: detectKind(connection),
    connection,
    safety: parseSafety(raw),
    driver: parseDriver(raw),
  };
}

function loadFile(): Raw {
  const path = process.env.DBRIDGE_CONFIG;
  if (!path) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("DBRIDGE_CONFIG must contain a JSON object.");
  }
  return parsed as Raw;
}

function parseEnv(): Raw {
  const out: Raw = {};
  for (const field of FIELDS) {
    const value = process.env[field.env];
    if (value !== undefined) {
      out[field.key] = coerce(value, field);
    }
  }
  return out;
}

function parseArgv(argv: string[]): { flags: Raw; positionals: string[] } {
  const flags: Raw = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const field = FIELDS.find((entry) => entry.flag === name);
    if (!field) {
      throw new Error(`Unknown flag: --${name}`);
    }
    let value: string;
    if (eq !== -1) {
      value = body.slice(eq + 1);
    } else if (field.type === "bool") {
      value = "true";
    } else {
      value = argv[i + 1] ?? "";
      i += 1;
    }
    flags[field.key] = coerce(value, field);
  }
  return { flags, positionals };
}

function coerce(value: string, field: FieldDef): unknown {
  switch (field.type) {
    case "list":
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    case "bool":
      return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
    default: {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new Error(`${field.env} must be an integer.`);
      }
      return parsed;
    }
  }
}

function mergeSources(...sources: Raw[]): Raw {
  const out: Raw = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        out[key] = value;
      }
    }
  }
  return out;
}

function parseSafety(raw: Raw): SafetyConfig {
  return {
    maxRows: positiveInt(raw.maxRows, "maxRows", DEFAULT_SAFETY.maxRows),
    hiddenColumns: stringArray(raw.hiddenColumns, "hiddenColumns"),
    allowedTables: stringArray(raw.allowedTables, "allowedTables"),
    blockedTables: stringArray(raw.blockedTables, "blockedTables"),
    maskedColumns: maskArray(raw.maskedColumns),
    maxCellChars: nonNegativeInt(raw.maxCellChars, "maxCellChars", DEFAULT_SAFETY.maxCellChars),
    maxResultBytes: nonNegativeInt(
      raw.maxResultBytes,
      "maxResultBytes",
      DEFAULT_SAFETY.maxResultBytes,
    ),
  };
}

function parseDriver(raw: Raw): DriverOptions {
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
    auditLog: boolValue(raw.auditLog, "auditLog", DEFAULT_DRIVER_OPTIONS.auditLog),
    maxCost: nonNegativeInt(raw.maxCost, "maxCost", DEFAULT_DRIVER_OPTIONS.maxCost),
    rateLimitPerMin: nonNegativeInt(
      raw.rateLimitPerMin,
      "rateLimitPerMin",
      DEFAULT_DRIVER_OPTIONS.rateLimitPerMin,
    ),
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

function maskArray(value: unknown): MaskSpec[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("maskedColumns must be an array.");
  }
  return value.map((entry) => normalizeMask(entry));
}

function normalizeMask(entry: unknown): MaskSpec {
  if (typeof entry === "string") {
    return { column: entry, strategy: "partial", keep: 4 };
  }
  if (typeof entry !== "object" || entry === null) {
    throw new Error("Each maskedColumns entry must be a string or an object.");
  }
  const record = entry as { column?: unknown; strategy?: unknown; keep?: unknown };
  if (typeof record.column !== "string" || record.column.length === 0) {
    throw new Error("maskedColumns entries need a non-empty column name.");
  }
  const strategy = normalizeStrategy(record.strategy);
  const keep =
    record.keep === undefined
      ? 4
      : typeof record.keep === "number" && Number.isInteger(record.keep) && record.keep >= 0
        ? record.keep
        : throwMask("keep must be a non-negative integer.");
  return { column: record.column, strategy, keep };
}

function normalizeStrategy(value: unknown): MaskStrategy {
  if (value === undefined) {
    return "partial";
  }
  if (value === "partial" || value === "email" || value === "full") {
    return value;
  }
  return throwMask("strategy must be 'partial', 'email', or 'full'.");
}

function throwMask(message: string): never {
  throw new Error(`maskedColumns: ${message}`);
}
