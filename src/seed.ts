import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outputPath = join(dirname(fileURLToPath(import.meta.url)), "..", "demo.db");

const products: Array<[number, string, number, number, string]> = [
  [1, "Umbrella", 14.99, 40, "Accessories"],
  [2, "Raincoat", 29.99, 15, "Clothing"],
  [3, "Beanie", 8.99, 3, "Accessories"],
  [4, "Thermos", 19.99, 25, "Home"],
  [5, "Notebook", 4.99, 120, "Stationery"],
  [6, "Wireless Headphones", 89.99, 8, "Electronics"],
];

const customers: Array<[number, string, string]> = [
  [1, "Alice Johnson", "New York"],
  [2, "Bob Miller", "Chicago"],
  [3, "Carol Davis", "Seattle"],
  [4, "Dan Wilson", "New York"],
  [5, "Eve Thompson", "Chicago"],
];

const sales: Array<[number, number, number, number, number, string]> = [
  [1, 1, 2, 3, 44.97, "2026-06-05"],
  [2, 1, 4, 5, 74.95, "2026-06-18"],
  [3, 2, 1, 2, 59.98, "2026-06-02"],
  [4, 6, 3, 1, 89.99, "2026-06-20"],
  [5, 5, 5, 10, 49.9, "2026-06-11"],
  [6, 4, 2, 3, 59.97, "2026-06-25"],
  [7, 1, 1, 4, 59.96, "2026-06-28"],
  [8, 3, 4, 6, 53.94, "2026-05-15"],
  [9, 2, 3, 1, 29.99, "2026-05-20"],
  [10, 6, 1, 2, 179.98, "2026-05-22"],
  [11, 5, 2, 20, 99.8, "2026-05-30"],
  [12, 1, 5, 8, 119.92, "2026-06-14"],
  [13, 4, 4, 1, 19.99, "2026-06-09"],
  [14, 3, 2, 2, 17.98, "2026-06-21"],
  [15, 2, 5, 1, 29.99, "2026-05-08"],
];

const db = new DatabaseSync(outputPath);

db.exec(`
  DROP TABLE IF EXISTS sales;
  DROP TABLE IF EXISTS products;
  DROP TABLE IF EXISTS customers;

  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    stock INTEGER NOT NULL,
    category TEXT NOT NULL
  );

  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL
  );

  CREATE TABLE sales (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    quantity INTEGER NOT NULL,
    total REAL NOT NULL,
    sold_at TEXT NOT NULL
  );
`);

const insertProduct = db.prepare(
  "INSERT INTO products (id, name, price, stock, category) VALUES (?, ?, ?, ?, ?)",
);
for (const row of products) {
  insertProduct.run(...row);
}

const insertCustomer = db.prepare("INSERT INTO customers (id, name, city) VALUES (?, ?, ?)");
for (const row of customers) {
  insertCustomer.run(...row);
}

const insertSale = db.prepare(
  "INSERT INTO sales (id, product_id, customer_id, quantity, total, sold_at) VALUES (?, ?, ?, ?, ?, ?)",
);
for (const row of sales) {
  insertSale.run(...row);
}

db.close();

process.stdout.write(`Seeded ${outputPath}\n`);
