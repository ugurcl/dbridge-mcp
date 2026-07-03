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

test("column_stats hides restricted columns and reports indexed cardinality", { skip }, async () => {
  const stats = await driver.columnStats("t_emp");
  const names = stats.columns.map((c) => c.column);
  assert.ok(names.includes("id"));
  assert.ok(!names.includes("maas"));
  const id = stats.columns.find((c) => c.column === "id");
  assert.equal(typeof id.distinctValues, "number");
});

test("index_health flags duplicate indexes", { skip }, async () => {
  const admin = createAdmin(url);
  await admin([
    "CREATE INDEX idx_emp_dept1 ON t_emp (dept_id)",
    "CREATE INDEX idx_emp_dept2 ON t_emp (dept_id)",
  ]);
  const report = await driver.indexHealth("t_emp");
  const dup = report.indexes.find((i) => i.index === "idx_emp_dept2");
  assert.ok(dup.issues.some((issue) => issue.includes("duplicate")));
  const primary = report.indexes.find((i) => i.index === "PRIMARY");
  assert.equal(primary.primary, true);
});

test("slow_queries returns digest statements without restricted ones", { skip }, async () => {
  await driver.runQuery("SELECT count(*) FROM t_dept");
  const report = await driver.slowQueries(10);
  assert.ok(Array.isArray(report.queries));
  assert.ok(report.queries.length > 0);
  assert.ok(report.queries.every((q) => !/maas|t_secrets/i.test(q.query)));
});
