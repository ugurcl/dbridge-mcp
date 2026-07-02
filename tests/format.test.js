import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv, toMarkdown } from "../dist/format.js";

const rows = [
  { ad: "Şemsiye", fiyat: 149.9 },
  { ad: "Kablo, USB", fiyat: 39.9 },
];

test("toCsv writes a header and quotes cells with commas", () => {
  assert.equal(toCsv(rows), 'ad,fiyat\nŞemsiye,149.9\n"Kablo, USB",39.9');
});

test("toCsv returns empty string for no rows", () => {
  assert.equal(toCsv([]), "");
});

test("toMarkdown builds a table", () => {
  assert.equal(
    toMarkdown(rows),
    "| ad | fiyat |\n| --- | --- |\n| Şemsiye | 149.9 |\n| Kablo, USB | 39.9 |",
  );
});

test("null cells render as empty", () => {
  assert.equal(toCsv([{ a: null, b: 1 }]), "a,b\n,1");
});
