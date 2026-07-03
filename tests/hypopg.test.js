import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDriver } from "../dist/drivers/index.js";

const url = process.env.PG_TEST_URL;
const skip = url ? false : "set PG_TEST_URL to run hypopg integration tests";

const options = {
  statementTimeoutMs: 5000,
  maxPoolSize: 2,
  connectionTimeoutMs: 5000,
  requireSsl: false,
  schemas: ["public"],
  auditLog: false,
  maxCost: 0,
  rateLimitPerMin: 0,
};

const safety = {
  maxRows: 1000,
  hiddenColumns: [],
  allowedTables: [],
  blockedTables: [],
  maskedColumns: [],
  maxCellChars: 0,
  maxResultBytes: 0,
};

let driver;

before(() => {
  if (skip) {
    return;
  }
  driver = createDriver("postgres", url, safety, options);
});

after(async () => {
  if (driver) {
    await driver.close();
  }
});

test("test_index reports whether the planner would use a hypothetical index", { skip }, async () => {
  const result = await driver.testIndex(
    "CREATE INDEX ON sales (customer_id)",
    "SELECT * FROM sales WHERE customer_id = 3",
  );
  assert.equal(typeof result.used, "boolean");
  assert.equal(typeof result.costBefore, "number");
  assert.equal(typeof result.costAfter, "number");
  assert.ok(result.verdict.length > 0);
  if (result.used) {
    assert.ok(result.costAfter <= result.costBefore);
    assert.ok(JSON.stringify(result.plan).includes("btree_sales_customer_id"));
  }
});

test("test_index leaves no hypothetical index behind", { skip }, async () => {
  await driver.testIndex("CREATE INDEX ON sales (product_id)", "SELECT * FROM sales WHERE product_id = 1");
  const after = await driver.runQuery("SELECT 1 AS ok");
  assert.equal(after.rows[0].ok, 1);
});

test("slow_queries returns recorded statements without restricted ones", { skip }, async () => {
  await driver.runQuery("SELECT count(*) FROM sales");
  const report = await driver.slowQueries(10);
  assert.ok(Array.isArray(report.queries));
  assert.ok(report.queries.length > 0);
  const first = report.queries[0];
  assert.equal(typeof first.query, "string");
  assert.equal(typeof first.calls, "number");
  assert.equal(typeof first.totalMs, "number");
  assert.ok(report.queries.every((q) => !/pg_catalog|information_schema/i.test(q.query)));
});
