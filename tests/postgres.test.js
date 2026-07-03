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
    "CREATE TABLE personel (id INTEGER PRIMARY KEY, ad TEXT, maas INTEGER); INSERT INTO personel VALUES (1, 'a', 100), (2, 'b', 200);",
  );
  await pg.exec(
    "CREATE TABLE gorev (id INTEGER PRIMARY KEY, personel_id INTEGER REFERENCES personel(id), ad TEXT);",
  );
  await pg.exec("CREATE TABLE secrets (token TEXT); INSERT INTO secrets VALUES ('x');");
  await pg.exec(
    "CREATE INDEX idx_gorev_p1 ON gorev(personel_id); CREATE INDEX idx_gorev_p2 ON gorev(personel_id); CREATE INDEX idx_personel_maas ON personel(maas);",
  );
  await pg.exec("ANALYZE personel;");
  driver = new PostgresDriver(
    makeClient(pg),
    {
      maxRows: 1000,
      hiddenColumns: ["maas"],
      allowedTables: [],
      blockedTables: ["secrets"],
      maskedColumns: [],
      maxCellChars: 0,
      maxResultBytes: 0,
    },
    options,
    () => pg.close(),
  );
});

after(async () => {
  await driver.close();
});

test("lists tables and hides blocked ones", async () => {
  assert.deepEqual(await driver.listTables(), ["gorev", "personel"]);
});

test("hides restricted column in describe_table", async () => {
  const schema = await driver.describeTable("personel");
  assert.deepEqual(
    schema.columns.map((c) => c.name),
    ["id", "ad"],
  );
});

test("reports primary key, foreign keys, and row count", async () => {
  const personel = await driver.describeTable("personel");
  assert.deepEqual(personel.primaryKey, ["id"]);
  assert.ok(personel.rowCount === null || typeof personel.rowCount === "number");

  const gorev = await driver.describeTable("gorev");
  assert.deepEqual(gorev.foreignKeys, [
    { column: "personel_id", referencesTable: "personel", referencesColumn: "id" },
  ]);
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

test("column_stats reports cardinality and hides restricted columns", async () => {
  const stats = await driver.columnStats("personel");
  assert.deepEqual(
    stats.columns.map((c) => c.column),
    ["id", "ad"],
  );
  const ad = stats.columns.find((c) => c.column === "ad");
  assert.equal(ad.distinctValues, 2);
  assert.equal(ad.nullFraction, 0);
});

test("column_stats rejects a blocked table", async () => {
  await assert.rejects(() => driver.columnStats("secrets"));
});

test("index_health flags duplicate indexes and skips hidden-column indexes", async () => {
  const report = await driver.indexHealth();
  const names = report.indexes.map((i) => i.index);
  assert.ok(names.includes("idx_gorev_p1"));
  assert.ok(!names.includes("idx_personel_maas"));
  const dup = report.indexes.find((i) => i.index === "idx_gorev_p2");
  assert.ok(dup.issues.some((issue) => issue.includes('duplicate: covers the same columns as "idx_gorev_p1"')));
  const pkey = report.indexes.find((i) => i.index === "personel_pkey");
  assert.equal(pkey.primary, true);
});

test("index_health scoped to one table only returns its indexes", async () => {
  const report = await driver.indexHealth("gorev");
  assert.ok(report.indexes.every((i) => i.table === "gorev"));
  assert.ok(report.indexes.length >= 2);
});

test("test_index explains that hypopg is missing", async () => {
  await assert.rejects(
    () => driver.testIndex("CREATE INDEX ON gorev (ad)", "SELECT * FROM gorev WHERE ad = 'x'"),
    /hypopg/,
  );
});

test("test_index validates the index definition first", async () => {
  await assert.rejects(
    () => driver.testIndex("DROP TABLE gorev", "SELECT 1"),
    /CREATE \[UNIQUE\] INDEX/,
  );
  await assert.rejects(
    () => driver.testIndex("CREATE INDEX i ON secrets (token)", "SELECT 1"),
    /Unknown table/,
  );
  await assert.rejects(
    () => driver.testIndex("CREATE INDEX i ON personel (maas)", "SELECT 1"),
    /restricted/,
  );
});
