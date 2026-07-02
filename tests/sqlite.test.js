import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDriver } from "../dist/drivers/sqlite.js";

let dir;
let driver;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "dbridge-"));
  const path = join(dir, "t.db");
  const seed = new DatabaseSync(path);
  seed.exec(
    "CREATE TABLE personel (id INTEGER PRIMARY KEY, ad TEXT, maas INTEGER); INSERT INTO personel VALUES (1, 'a', 100), (2, 'b', 200);",
  );
  seed.exec(
    "CREATE TABLE gorev (id INTEGER PRIMARY KEY, personel_id INTEGER REFERENCES personel(id), ad TEXT);",
  );
  seed.exec("CREATE TABLE secrets (token TEXT); INSERT INTO secrets VALUES ('x');");
  seed.exec(
    "CREATE INDEX idx_gorev_p1 ON gorev(personel_id); CREATE INDEX idx_gorev_p2 ON gorev(personel_id); CREATE INDEX idx_personel_maas ON personel(maas);",
  );
  seed.close();
  driver = new SqliteDriver(path, {
    maxRows: 1000,
    hiddenColumns: ["maas"],
    allowedTables: [],
    blockedTables: ["secrets"],
    maskedColumns: [],
    maxCellChars: 0,
    maxResultBytes: 0,
  });
});

after(async () => {
  await driver.close();
  rmSync(dir, { recursive: true, force: true });
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

test("reports primary key and foreign keys", async () => {
  const personel = await driver.describeTable("personel");
  assert.deepEqual(personel.primaryKey, ["id"]);

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
  const path = join(dir, "cap.db");
  const seed = new DatabaseSync(path);
  seed.exec("CREATE TABLE n (v INTEGER);");
  seed.exec("INSERT INTO n VALUES (1), (2), (3);");
  seed.close();
  const capped = new SqliteDriver(path, {
    maxRows: 1,
    hiddenColumns: [],
    allowedTables: [],
    blockedTables: [],
    maskedColumns: [],
  });
  const result = await capped.runQuery("SELECT * FROM n LIMIT 1000");
  assert.equal(result.rowCount, 1);
  assert.equal(result.truncated, true);
  await capped.close();
});

test("counts rows", async () => {
  assert.equal(await driver.countRows("personel"), 2);
});

test("refuses to count a blocked table", async () => {
  await assert.rejects(() => driver.countRows("secrets"));
});

test("explains a query", async () => {
  const result = await driver.explainQuery("SELECT * FROM personel");
  assert.ok(Array.isArray(result.plan));
});

test("masks configured columns in results", async () => {
  const path = join(dir, "mask.db");
  const seed = new DatabaseSync(path);
  seed.exec("CREATE TABLE m (email TEXT);");
  seed.exec("INSERT INTO m VALUES ('ayse@site.com');");
  seed.close();
  const masking = new SqliteDriver(path, {
    maxRows: 1000,
    hiddenColumns: [],
    allowedTables: [],
    blockedTables: [],
    maskedColumns: [{ column: "email", strategy: "email", keep: 4 }],
  });
  const result = await masking.runQuery("SELECT email FROM m");
  assert.equal(result.rows[0].email, "a***@site.com");
  await masking.close();
});

test("column_stats reports cardinality and hides restricted columns", async () => {
  const stats = await driver.columnStats("personel");
  assert.equal(stats.rowEstimate, 2);
  assert.deepEqual(
    stats.columns.map((c) => c.column),
    ["id", "ad"],
  );
  const ad = stats.columns.find((c) => c.column === "ad");
  assert.equal(ad.distinctValues, 2);
  assert.equal(ad.nullFraction, 0);
});

test("index_health flags duplicate indexes and skips hidden-column indexes", async () => {
  const report = await driver.indexHealth();
  const names = report.indexes.map((i) => i.index);
  assert.ok(names.includes("idx_gorev_p1"));
  assert.ok(!names.includes("idx_personel_maas"));
  const dup = report.indexes.find((i) => i.index === "idx_gorev_p2");
  assert.ok(dup.issues.some((issue) => issue.includes('duplicate: covers the same columns as "idx_gorev_p1"')));
});

test("index_health rejects an unknown table", async () => {
  await assert.rejects(() => driver.indexHealth("yok"));
});
