import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeQuery,
  visibleColumns,
  redactRows,
  isTableAllowed,
  filterTables,
  capRows,
  DEFAULT_SAFETY,
} from "../dist/guard.js";

const withHidden = { ...DEFAULT_SAFETY, maxRows: 1000, hiddenColumns: ["maas"] };

test("appends a limit when none is present", () => {
  const { sql, rowCap } = sanitizeQuery("SELECT * FROM urunler", DEFAULT_SAFETY);
  assert.equal(sql, "SELECT * FROM urunler LIMIT 1001");
  assert.equal(rowCap, 1000);
});

test("keeps a user limit at or below maxRows", () => {
  const { sql, rowCap } = sanitizeQuery("SELECT 1 LIMIT 5", DEFAULT_SAFETY);
  assert.equal(sql, "SELECT 1 LIMIT 5");
  assert.equal(rowCap, Infinity);
});

test("caps a user limit above maxRows", () => {
  const small = { ...DEFAULT_SAFETY, maxRows: 500 };
  const { sql, rowCap } = sanitizeQuery("SELECT * FROM satislar LIMIT 1000000", small);
  assert.equal(sql, "SELECT * FROM satislar LIMIT 501");
  assert.equal(rowCap, 500);
});

test("caps a limit with an offset", () => {
  const small = { ...DEFAULT_SAFETY, maxRows: 500 };
  const { sql } = sanitizeQuery("SELECT * FROM satislar LIMIT 9999 OFFSET 10", small);
  assert.equal(sql, "SELECT * FROM satislar LIMIT 501 OFFSET 10");
});

test("allows WITH statements", () => {
  const { sql } = sanitizeQuery("WITH t AS (SELECT 1 AS n) SELECT n FROM t LIMIT 1", DEFAULT_SAFETY);
  assert.equal(sql, "WITH t AS (SELECT 1 AS n) SELECT n FROM t LIMIT 1");
});

test("rejects writes and DDL", () => {
  assert.throws(() => sanitizeQuery("DELETE FROM urunler", DEFAULT_SAFETY));
  assert.throws(() => sanitizeQuery("DROP TABLE urunler", DEFAULT_SAFETY));
  assert.throws(() => sanitizeQuery("UPDATE urunler SET stok = 0", DEFAULT_SAFETY));
});

test("rejects data-modifying CTEs", () => {
  assert.throws(() =>
    sanitizeQuery("WITH x AS (DELETE FROM urunler RETURNING id) SELECT * FROM x", DEFAULT_SAFETY),
  );
});

test("rejects multiple statements", () => {
  assert.throws(() => sanitizeQuery("SELECT 1; SELECT 2", DEFAULT_SAFETY));
});

test("rejects system catalog access", () => {
  assert.throws(() => sanitizeQuery("SELECT * FROM information_schema.tables", DEFAULT_SAFETY));
  assert.throws(() => sanitizeQuery("SELECT * FROM pg_shadow", DEFAULT_SAFETY));
  assert.throws(() => sanitizeQuery("SELECT name FROM sqlite_master", DEFAULT_SAFETY));
});

test("rejects queries that touch a hidden column", () => {
  assert.throws(() => sanitizeQuery("SELECT maas FROM personel", withHidden));
});

test("rejects queries that touch a blocked table", () => {
  const blocked = { ...DEFAULT_SAFETY, blockedTables: ["personel"] };
  assert.throws(() => sanitizeQuery("SELECT * FROM personel", blocked));
});

test("hides restricted columns from a column list", () => {
  const columns = [
    { name: "ad", type: "TEXT", nullable: false },
    { name: "maas", type: "INTEGER", nullable: false },
  ];
  assert.deepEqual(
    visibleColumns(columns, withHidden).map((c) => c.name),
    ["ad"],
  );
});

test("redacts restricted columns from rows", () => {
  assert.deepEqual(redactRows([{ ad: "a", maas: 100 }], withHidden), [{ ad: "a" }]);
});

test("isTableAllowed honors allow and block lists", () => {
  const blocked = { ...DEFAULT_SAFETY, blockedTables: ["secrets"] };
  assert.equal(isTableAllowed("secrets", blocked), false);
  assert.equal(isTableAllowed("urunler", blocked), true);

  const allowed = { ...DEFAULT_SAFETY, allowedTables: ["urunler", "satislar"] };
  assert.equal(isTableAllowed("urunler", allowed), true);
  assert.equal(isTableAllowed("personel", allowed), false);
});

test("isTableAllowed matches schema-qualified names", () => {
  const allowed = { ...DEFAULT_SAFETY, allowedTables: ["sales"] };
  assert.equal(isTableAllowed("reporting.sales", allowed), true);
});

test("filterTables drops disallowed tables", () => {
  const blocked = { ...DEFAULT_SAFETY, blockedTables: ["secrets"] };
  assert.deepEqual(filterTables(["urunler", "secrets", "satislar"], blocked), ["urunler", "satislar"]);
});

test("capRows slices to the cap and flags truncation", () => {
  const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
  assert.deepEqual(capRows(rows, 2), { rows: [{ n: 1 }, { n: 2 }], truncated: true });
  assert.deepEqual(capRows(rows, 5), { rows, truncated: false });
});
