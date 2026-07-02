import pg from "pg";
import type { Driver } from "./types.js";
import type { SafetyConfig } from "../guard.js";
import { SqliteDriver } from "./sqlite.js";
import { PostgresDriver } from "./postgres.js";

export type DriverKind = "sqlite" | "postgres";

export function createDriver(
  kind: DriverKind,
  connection: string,
  safety: SafetyConfig,
): Driver {
  switch (kind) {
    case "sqlite":
      return new SqliteDriver(connection, safety);
    case "postgres": {
      const pool = new pg.Pool({ connectionString: connection });
      return new PostgresDriver(
        { query: (text, params) => pool.query(text, params) },
        safety,
        () => pool.end(),
      );
    }
    default:
      throw new Error(`Unsupported database kind: ${kind}`);
  }
}
