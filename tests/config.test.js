import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";

const OWNED = [
  "DBRIDGE_DB_PATH",
  "DBRIDGE_CONFIG",
  "DBRIDGE_MAX_ROWS",
  "DBRIDGE_REQUIRE_SSL",
  "DBRIDGE_MASKED_COLUMNS",
  "DBRIDGE_RATE_LIMIT_PER_MIN",
];

beforeEach(() => {
  for (const key of OWNED) {
    delete process.env[key];
  }
});

test("defaults apply when nothing is set", () => {
  const config = loadConfig(["demo.db"]);
  assert.equal(config.kind, "sqlite");
  assert.equal(config.safety.maxRows, 1000);
  assert.equal(config.driver.maxPoolSize, 5);
});

test("cli flags override defaults", () => {
  const config = loadConfig([
    "demo.db",
    "--max-rows",
    "50",
    "--require-ssl",
    "--masked-columns",
    "email,iban",
    "--rate-limit-per-min=30",
  ]);
  assert.equal(config.safety.maxRows, 50);
  assert.equal(config.driver.requireSsl, true);
  assert.equal(config.driver.rateLimitPerMin, 30);
  assert.deepEqual(
    config.safety.maskedColumns.map((m) => m.column),
    ["email", "iban"],
  );
});

test("cli flags win over env vars", () => {
  process.env.DBRIDGE_MAX_ROWS = "77";
  const config = loadConfig(["demo.db", "--max-rows", "50"]);
  assert.equal(config.safety.maxRows, 50);
});

test("env vars override defaults", () => {
  process.env.DBRIDGE_MAX_ROWS = "77";
  process.env.DBRIDGE_REQUIRE_SSL = "true";
  const config = loadConfig(["demo.db"]);
  assert.equal(config.safety.maxRows, 77);
  assert.equal(config.driver.requireSsl, true);
});

test("connection can come from an env var", () => {
  process.env.DBRIDGE_DB_PATH = "postgresql://localhost/db";
  const config = loadConfig([]);
  assert.equal(config.kind, "postgres");
  assert.equal(config.connection, "postgresql://localhost/db");
});

test("rejects unknown flags", () => {
  assert.throws(() => loadConfig(["demo.db", "--nope", "1"]));
});

test("rejects a non-integer numeric flag", () => {
  assert.throws(() => loadConfig(["demo.db", "--max-rows", "abc"]));
});
