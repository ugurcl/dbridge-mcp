import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDriver } from "../dist/drivers/index.js";

const url = process.env.MYSQL_TEST_URL;
const skip = url ? false : "set MYSQL_TEST_URL to run MySQL integration tests";

const options = {
  statementTimeoutMs: 2000,
  maxPoolSize: 3,
  connectionTimeoutMs: 5000,
  requireSsl: false,
  schemas: ["public"],
  auditLog: false,
  maxCost: 0,
  rateLimitPerMin: 0,
};

const safety = {
  maxRows: 1000,
  hiddenColumns: ["maas"],
  allowedTables: [],
  blockedTables: ["t_secrets"],
  maskedColumns: [],
  maxCellChars: 0,
  maxResultBytes: 0,
};

let driver;

before(async () => {
  if (skip) {
    return;
  }
  const admin = createAdmin(url);
  await admin([
    "DROP TABLE IF EXISTS t_emp",
    "DROP TABLE IF EXISTS t_dept",
    "DROP TABLE IF EXISTS t_secrets",
    "CREATE TABLE t_dept (id INT PRIMARY KEY, ad VARCHAR(50))",
    "CREATE TABLE t_emp (id INT PRIMARY KEY, dept_id INT, ad VARCHAR(50), maas INT, FOREIGN KEY (dept_id) REFERENCES t_dept(id))",
    "CREATE TABLE t_secrets (token VARCHAR(50))",
    "INSERT INTO t_dept VALUES (1, 'Satış'), (2, 'Depo')",
    "INSERT INTO t_emp VALUES (1, 1, 'Ali', 100), (2, 2, 'Ayşe', 200)",
    "INSERT INTO t_secrets VALUES ('x')",
  ]);
  driver = createDriver("mysql", url, safety, options);
});

after(async () => {
  if (driver) {
    await driver.close();
  }
});

test("lists tables and hides blocked ones", { skip }, async () => {
  const tables = await driver.listTables();
  assert.ok(tables.includes("t_emp") && tables.includes("t_dept"));
  assert.ok(!tables.includes("t_secrets"));
});

test("describes columns, primary key, and foreign keys", { skip }, async () => {
  const schema = await driver.describeTable("t_emp");
  assert.ok(!schema.columns.some((c) => c.name === "maas"));
  assert.deepEqual(schema.primaryKey, ["id"]);
  assert.deepEqual(schema.foreignKeys, [
    { column: "dept_id", referencesTable: "t_dept", referencesColumn: "id" },
  ]);
});

test("counts rows", { skip }, async () => {
  assert.equal(await driver.countRows("t_emp"), 2);
});

test("blocks writes", { skip }, async () => {
  await assert.rejects(() => driver.runQuery("DELETE FROM t_emp"));
});

test("blocks a blocked table", { skip }, async () => {
  await assert.rejects(() => driver.runQuery("SELECT * FROM t_secrets"));
});

test("redacts hidden columns from results", { skip }, async () => {
  const result = await driver.runQuery("SELECT * FROM t_emp");
  assert.ok(result.rows.every((row) => !("maas" in row)));
});

function createAdmin(connectionUrl) {
  return async (statements) => {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection(connectionUrl);
    try {
      for (const statement of statements) {
        await conn.query(statement);
      }
    } finally {
      await conn.end();
    }
  };
}
