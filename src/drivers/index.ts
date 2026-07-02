import pg from "pg";
import mysql from "mysql2/promise";
import type { Driver } from "./types.js";
import type { SafetyConfig } from "../guard.js";
import type { DriverOptions } from "../config.js";
import { SqliteDriver } from "./sqlite.js";
import { PostgresDriver, type SqlClient } from "./postgres.js";
import { MySqlDriver, type MySqlClient } from "./mysql.js";

export type DriverKind = "sqlite" | "postgres" | "mysql";

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
        {
          statementTimeoutMs: options.statementTimeoutMs,
          schemas: options.schemas,
          maxCost: options.maxCost,
        },
        () => pool.end(),
      );
    }
    case "mysql": {
      const pool = mysql.createPool({
        uri: connection,
        connectionLimit: options.maxPoolSize,
        connectTimeout: options.connectionTimeoutMs,
        ssl: options.requireSsl ? { rejectUnauthorized: true } : undefined,
        namedPlaceholders: false,
      });
      const client: MySqlClient = {
        query: async (text, params) => {
          const [rows] = await pool.query(text, params);
          return { rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [] };
        },
        session: async (fn) => {
          const connectionClient = await pool.getConnection();
          try {
            return await fn(async (text, params) => {
              const [rows] = await connectionClient.query(text, params);
              return { rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [] };
            });
          } finally {
            connectionClient.release();
          }
        },
      };
      return new MySqlDriver(
        client,
        safety,
        { statementTimeoutMs: options.statementTimeoutMs, maxCost: options.maxCost },
        () => pool.end(),
      );
    }
    default:
      throw new Error(`Unsupported database kind: ${kind}`);
  }
}
