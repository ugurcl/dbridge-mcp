import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeQuery,
  visibleColumns,
  redactRows,
  maskRows,
  isTableAllowed,
  filterTables,
  capRows,
  truncateCells,
  capBytes,
  DEFAULT_SAFETY,
  sanitizeIndexDefinition,
} from "../dist/guard.js";

const withHidden = { ...DEFAULT_SAFETY, maxRows: 1000, hiddenColumns: ["maas"] };

test("appends a limit when none is present", () => {
  const { sql, rowCap } = sanitizeQuery("SELECT * FROM products", DEFAULT_SAFETY);
  assert.equal(sql, "SELECT * FROM products LIMIT 1001");
  assert.equal(rowCap, 1000);
});

test("keeps a user limit at or below maxRows", () => {
  const { sql, rowCap } = sanitizeQuery("SELECT 1 LIMIT 5", DEFAULT_SAFETY);
  assert.equal(sql, "SELECT 1 LIMIT 5");
  assert.equal(rowCap, Infinity);
});

test("caps a user limit above maxRows", () => {
  const small = { ...DEFAULT_SAFETY, maxRows: 500 };
  const { sql, rowCap } = sanitizeQuery("SELECT * FROM sales LIMIT 1000000", small);
  assert.equal(sql, "SELECT * FROM sales LIMIT 501");
  assert.equal(rowCap, 500);
});

test("caps a limit with an offset", () => {
  const small = { ...DEFAULT_SAFETY, maxRows: 500 };
  const { sql } = sanitizeQuery("SELECT * FROM sales LIMIT 9999 OFFSET 10", small);
  assert.equal(sql, "SELECT * FROM sales LIMIT 501 OFFSET 10");
});

test("allows WITH statements", () => {
  const { sql } = sanitizeQuery("WITH t AS (SELECT 1 AS n) SELECT n FROM t LIMIT 1", DEFAULT_SAFETY);
  assert.equal(sql, "WITH t AS (SELECT 1 AS n) SELECT n FROM t LIMIT 1");
});

test("rejects writes and DDL", () => {
  assert.throws(() => sanitizeQuery("DELETE FROM products", DEFAULT_SAFETY));
  assert.throws(() => sanitizeQuery("DROP TABLE products", DEFAULT_SAFETY));
  assert.throws(() => sanitizeQuery("UPDATE products SET stock = 0", DEFAULT_SAFETY));
});

test("rejects data-modifying CTEs", () => {
  assert.throws(() =>
    sanitizeQuery("WITH x AS (DELETE FROM products RETURNING id) SELECT * FROM x", DEFAULT_SAFETY),
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
  const blocked = { ...DEFAULT_SAFETY, blockedTables: ["employees"] };
  assert.throws(() => sanitizeQuery("SELECT * FROM employees", blocked));
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
  assert.equal(isTableAllowed("products", blocked), true);

  const allowed = { ...DEFAULT_SAFETY, allowedTables: ["products", "sales"] };
  assert.equal(isTableAllowed("products", allowed), true);
  assert.equal(isTableAllowed("employees", allowed), false);
});

test("isTableAllowed matches schema-qualified names", () => {
  const allowed = { ...DEFAULT_SAFETY, allowedTables: ["sales"] };
  assert.equal(isTableAllowed("reporting.sales", allowed), true);
});

test("filterTables drops disallowed tables", () => {
  const blocked = { ...DEFAULT_SAFETY, blockedTables: ["secrets"] };
  assert.deepEqual(filterTables(["products", "secrets", "sales"], blocked), ["products", "sales"]);
});

test("maskRows applies partial, email, and full strategies", () => {
  const specs = [
    { column: "iban", strategy: "partial", keep: 4 },
    { column: "email", strategy: "email", keep: 4 },
    { column: "token", strategy: "full", keep: 0 },
  ];
  const masked = maskRows(
    [{ iban: "TR120001", email: "ayse@site.com", token: "secret", ad: "Ayşe" }],
    specs,
  );
  assert.deepEqual(masked, [
    { iban: "****0001", email: "a***@site.com", token: "***", ad: "Ayşe" },
  ]);
});

test("maskRows leaves nulls and unlisted columns untouched", () => {
  const specs = [{ column: "iban", strategy: "partial", keep: 4 }];
  assert.deepEqual(maskRows([{ iban: null, ad: "x" }], specs), [{ iban: null, ad: "x" }]);
});

test("capRows slices to the cap and flags truncation", () => {
  const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
  assert.deepEqual(capRows(rows, 2), { rows: [{ n: 1 }, { n: 2 }], truncated: true });
  assert.deepEqual(capRows(rows, 5), { rows, truncated: false });
});

test("truncateCells shortens long string cells", () => {
  const rows = [{ note: "abcdefghij", n: 5 }];
  assert.deepEqual(truncateCells(rows, 4), [{ note: "abcd…", n: 5 }]);
  assert.deepEqual(truncateCells(rows, 0), rows);
});

test("capBytes stops once the byte budget is exceeded", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ i, pad: "x".repeat(50) }));
  const result = capBytes(rows, 200);
  assert.ok(result.truncated);
  assert.ok(result.rows.length >= 1 && result.rows.length < 100);
  assert.deepEqual(capBytes(rows, 0), { rows, truncated: false });
});

test("sanitizeIndexDefinition accepts a plain CREATE INDEX", () => {
  const { sql, table } = sanitizeIndexDefinition(
    "CREATE INDEX idx_s ON sales (customer_id);",
    DEFAULT_SAFETY,
  );
  assert.equal(sql, "CREATE INDEX idx_s ON sales (customer_id)");
  assert.equal(table, "sales");
});

test("sanitizeIndexDefinition rejects non-index statements", () => {
  assert.throws(() => sanitizeIndexDefinition("DROP TABLE sales", DEFAULT_SAFETY));
  assert.throws(() => sanitizeIndexDefinition("SELECT 1", DEFAULT_SAFETY));
  assert.throws(() =>
    sanitizeIndexDefinition("CREATE INDEX i ON s (a); DROP TABLE s", DEFAULT_SAFETY),
  );
});

test("sanitizeIndexDefinition honors blocked tables and hidden columns", () => {
  const blocked = { ...DEFAULT_SAFETY, blockedTables: ["employees"] };
  assert.throws(() => sanitizeIndexDefinition("CREATE INDEX i ON employees (id)", blocked));
  const hidden = { ...DEFAULT_SAFETY, hiddenColumns: ["salary"] };
  assert.throws(() => sanitizeIndexDefinition("CREATE INDEX i ON t (salary)", hidden));
});
