import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outputPath = join(dirname(fileURLToPath(import.meta.url)), "..", "demo.db");

const products: Array<[number, string, number, number, string]> = [
  [1, "Şemsiye", 149.9, 40, "Aksesuar"],
  [2, "Yağmurluk", 299.9, 15, "Giyim"],
  [3, "Bere", 89.9, 3, "Aksesuar"],
  [4, "Termos", 199.9, 25, "Ev"],
  [5, "Defter", 49.9, 120, "Kırtasiye"],
  [6, "Kablosuz Kulaklık", 899.9, 8, "Elektronik"],
];

const customers: Array<[number, string, string]> = [
  [1, "Ahmet Yılmaz", "İstanbul"],
  [2, "Elif Demir", "Ankara"],
  [3, "Mehmet Kaya", "İzmir"],
  [4, "Zeynep Şahin", "İstanbul"],
  [5, "Can Öztürk", "Ankara"],
];

const sales: Array<[number, number, number, number, number, string]> = [
  [1, 1, 2, 3, 449.7, "2026-06-05"],
  [2, 1, 4, 5, 749.5, "2026-06-18"],
  [3, 2, 1, 2, 599.8, "2026-06-02"],
  [4, 6, 3, 1, 899.9, "2026-06-20"],
  [5, 5, 5, 10, 499.0, "2026-06-11"],
  [6, 4, 2, 3, 599.7, "2026-06-25"],
  [7, 1, 1, 4, 599.6, "2026-06-28"],
  [8, 3, 4, 6, 539.4, "2026-05-15"],
  [9, 2, 3, 1, 299.9, "2026-05-20"],
  [10, 6, 1, 2, 1799.8, "2026-05-22"],
  [11, 5, 2, 20, 998.0, "2026-05-30"],
  [12, 1, 5, 8, 1199.2, "2026-06-14"],
  [13, 4, 4, 1, 199.9, "2026-06-09"],
  [14, 3, 2, 2, 179.8, "2026-06-21"],
  [15, 2, 5, 1, 299.9, "2026-05-08"],
];

const db = new DatabaseSync(outputPath);

db.exec(`
  DROP TABLE IF EXISTS satislar;
  DROP TABLE IF EXISTS urunler;
  DROP TABLE IF EXISTS musteriler;

  CREATE TABLE urunler (
    id INTEGER PRIMARY KEY,
    ad TEXT NOT NULL,
    fiyat REAL NOT NULL,
    stok INTEGER NOT NULL,
    kategori TEXT NOT NULL
  );

  CREATE TABLE musteriler (
    id INTEGER PRIMARY KEY,
    ad TEXT NOT NULL,
    sehir TEXT NOT NULL
  );

  CREATE TABLE satislar (
    id INTEGER PRIMARY KEY,
    urun_id INTEGER NOT NULL REFERENCES urunler(id),
    musteri_id INTEGER NOT NULL REFERENCES musteriler(id),
    adet INTEGER NOT NULL,
    tutar REAL NOT NULL,
    tarih TEXT NOT NULL
  );
`);

const insertUrun = db.prepare(
  "INSERT INTO urunler (id, ad, fiyat, stok, kategori) VALUES (?, ?, ?, ?, ?)",
);
for (const row of products) {
  insertUrun.run(...row);
}

const insertMusteri = db.prepare("INSERT INTO musteriler (id, ad, sehir) VALUES (?, ?, ?)");
for (const row of customers) {
  insertMusteri.run(...row);
}

const insertSatis = db.prepare(
  "INSERT INTO satislar (id, urun_id, musteri_id, adet, tutar, tarih) VALUES (?, ?, ?, ?, ?, ?)",
);
for (const row of sales) {
  insertSatis.run(...row);
}

db.close();

process.stdout.write(`Seeded ${outputPath}\n`);
