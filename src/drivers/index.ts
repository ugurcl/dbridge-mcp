import pg from "pg";
import type { Driver } from "./types.js";
import type { SafetyConfig } from "../guard.js";
import type { DriverOptions } from "../config.js";
import { SqliteDriver } from "./sqlite.js";
import { PostgresDriver, type SqlClient } from "./postgres.js";

export type DriverKind = "sqlite" | "postgres";

export function createDriver(
  kind: DriverKind,
  connection: string,
  safety: SafetyConfig,
  options: DriverOptions,
): Driver {
  switch (kind) {
    case "sqlite":
      return new SqliteDriver(connection, safety);
    case "postgres": {
      const pool = new pg.Pool({
        connectionString: connection,
        max: options.maxPoolSize,
        connectionTimeoutMillis: options.connectionTimeoutMs,
        ssl: options.requireSsl ? { rejectUnauthorized: true } : undefined,
      });
      const client: SqlClient = {
        query: (text, params) => pool.query(text, params),
        session: async (fn) => {
          const connectionClient = await pool.connect();
          try {
            return await fn((text, params) => connectionClient.query(text, params));
          } finally {
            connectionClient.release();
          }
        },
      };
      return new PostgresDriver(
        client,
        safety,
        { statementTimeoutMs: options.statementTimeoutMs, schemas: options.schemas },
        () => pool.end(),
      );
    }
    default:
      throw new Error(`Unsupported database kind: ${kind}`);
  }
}
