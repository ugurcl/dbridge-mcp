import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PostgresDriver } from "../dist/drivers/postgres.js";

let pg;
let driver;

before(async () => {
  pg = new PGlite();
  await pg.exec(
    "CREATE TABLE personel (ad TEXT, maas INTEGER); INSERT INTO personel VALUES ('a', 100), ('b', 200);",
  );
  driver = new PostgresDriver(
    { query: (text, params) => pg.query(text, params) },
    { maxRows: 1000, hiddenColumns: ["maas"] },
    () => pg.close(),
  );
});

after(async () => {
  await driver.close();
});

test("lists tables", async () => {
  assert.deepEqual(await driver.listTables(), ["personel"]);
});

test("hides restricted column in describe_table", async () => {
  const columns = await driver.describeTable("personel");
  assert.deepEqual(columns.map((c) => c.name), ["ad"]);
});

test("throws on an unknown table", async () => {
  await assert.rejects(() => driver.describeTable("yok"));
});

test("redacts restricted column from SELECT *", async () => {
  const result = await driver.runQuery("SELECT * FROM personel");
  assert.equal(result.rowCount, 2);
  assert.ok(result.rows.every((row) => !("maas" in row)));
});

test("blocks writes at the driver", async () => {
  await assert.rejects(() => driver.runQuery("DELETE FROM personel"));
});
