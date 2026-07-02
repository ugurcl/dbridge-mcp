import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PostgresDriver } from "../dist/drivers/postgres.js";

let pg;
let driver;

const options = { statementTimeoutMs: 0, schemas: ["public"] };

function makeClient(instance) {
  return {
    query: (text, params) => instance.query(text, params),
    session: async (fn) => fn((text, params) => instance.query(text, params)),
  };
}

before(async () => {
  pg = new PGlite();
  await pg.exec(
    "CREATE TABLE personel (ad TEXT, maas INTEGER); INSERT INTO personel VALUES ('a', 100), ('b', 200);",
  );
  await pg.exec("CREATE TABLE secrets (token TEXT); INSERT INTO secrets VALUES ('x');");
  driver = new PostgresDriver(
    makeClient(pg),
    {
      maxRows: 1000,
      hiddenColumns: ["maas"],
      allowedTables: [],
      blockedTables: ["secrets"],
      maskedColumns: [],
    },
    options,
    () => pg.close(),
  );
});

after(async () => {
  await driver.close();
});

test("lists tables and hides blocked ones", async () => {
  assert.deepEqual(await driver.listTables(), ["personel"]);
});

test("hides restricted column in describe_table", async () => {
  const columns = await driver.describeTable("personel");
  assert.deepEqual(
    columns.map((c) => c.name),
    ["ad"],
  );
});

test("throws on an unknown table", async () => {
  await assert.rejects(() => driver.describeTable("yok"));
});

test("treats a blocked table as unknown", async () => {
  await assert.rejects(() => driver.describeTable("secrets"));
});

test("redacts restricted column from SELECT *", async () => {
  const result = await driver.runQuery("SELECT * FROM personel");
  assert.equal(result.rowCount, 2);
  assert.ok(result.rows.every((row) => !("maas" in row)));
  assert.equal(typeof result.elapsedMs, "number");
});

test("blocks writes at the driver", async () => {
  await assert.rejects(() => driver.runQuery("DELETE FROM personel"));
});

test("blocks queries against a blocked table", async () => {
  await assert.rejects(() => driver.runQuery("SELECT * FROM secrets"));
});

test("enforces the row cap over a larger user limit", async () => {
  const capped = new PostgresDriver(
    makeClient(pg),
    { maxRows: 1, hiddenColumns: [], allowedTables: [], blockedTables: [], maskedColumns: [] },
    options,
    async () => undefined,
  );
  const result = await capped.runQuery("SELECT * FROM personel LIMIT 1000");
  assert.equal(result.rowCount, 1);
  assert.equal(result.truncated, true);
});

test("counts rows", async () => {
  assert.equal(await driver.countRows("personel"), 2);
});

test("refuses to count a blocked table", async () => {
  await assert.rejects(() => driver.countRows("secrets"));
});

test("explains a query with an estimated cost", async () => {
  const result = await driver.explainQuery("SELECT * FROM personel");
  assert.equal(typeof result.totalCost, "number");
});

test("rejects queries above the cost limit", async () => {
  const strict = new PostgresDriver(
    makeClient(pg),
    { maxRows: 1000, hiddenColumns: [], allowedTables: [], blockedTables: [], maskedColumns: [] },
    { statementTimeoutMs: 0, schemas: ["public"], maxCost: 0.001 },
    async () => undefined,
  );
  await assert.rejects(() => strict.runQuery("SELECT * FROM personel"), /estimated cost/);
});

test("masks configured columns in results", async () => {
  const masking = new PostgresDriver(
    makeClient(pg),
    {
      maxRows: 1000,
      hiddenColumns: [],
      allowedTables: [],
      blockedTables: [],
      maskedColumns: [{ column: "ad", strategy: "full", keep: 0 }],
    },
    options,
    async () => undefined,
  );
  const result = await masking.runQuery("SELECT ad FROM personel ORDER BY ad");
  assert.ok(result.rows.every((row) => row.ad === "***"));
});
