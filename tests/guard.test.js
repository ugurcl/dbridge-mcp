import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeQuery, visibleColumns, redactRows, DEFAULT_SAFETY } from "../dist/guard.js";

const withHidden = { maxRows: 1000, hiddenColumns: ["maas"] };

test("appends a limit when none is present", () => {
  assert.equal(sanitizeQuery("SELECT * FROM urunler", DEFAULT_SAFETY), "SELECT * FROM urunler LIMIT 1000");
});

test("keeps an existing limit", () => {
  assert.equal(sanitizeQuery("SELECT 1 LIMIT 5", DEFAULT_SAFETY), "SELECT 1 LIMIT 5");
});

test("allows WITH statements", () => {
  assert.equal(
    sanitizeQuery("WITH t AS (SELECT 1 AS n) SELECT n FROM t LIMIT 1", DEFAULT_SAFETY),
    "WITH t AS (SELECT 1 AS n) SELECT n FROM t LIMIT 1",
  );
});

test("rejects writes and DDL", () => {
  assert.throws(() => sanitizeQuery("DELETE FROM urunler", DEFAULT_SAFETY));
  assert.throws(() => sanitizeQuery("DROP TABLE urunler", DEFAULT_SAFETY));
  assert.throws(() => sanitizeQuery("UPDATE urunler SET stok = 0", DEFAULT_SAFETY));
});

test("rejects multiple statements", () => {
  assert.throws(() => sanitizeQuery("SELECT 1; SELECT 2", DEFAULT_SAFETY));
});

test("rejects queries that touch a hidden column", () => {
  assert.throws(() => sanitizeQuery("SELECT maas FROM personel", withHidden));
});

test("hides restricted columns from a column list", () => {
  const columns = [
    { name: "ad", type: "TEXT", nullable: false },
    { name: "maas", type: "INTEGER", nullable: false },
  ];
  assert.deepEqual(visibleColumns(columns, withHidden).map((c) => c.name), ["ad"]);
});

test("redacts restricted columns from rows", () => {
  assert.deepEqual(redactRows([{ ad: "a", maas: 100 }], withHidden), [{ ad: "a" }]);
});
