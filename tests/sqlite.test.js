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
    "CREATE TABLE personel (ad TEXT, maas INTEGER); INSERT INTO personel VALUES ('a', 100), ('b', 200);",
  );
  seed.close();
  driver = new SqliteDriver(path, { maxRows: 1000, hiddenColumns: ["maas"] });
});

after(async () => {
  await driver.close();
  rmSync(dir, { recursive: true, force: true });
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
