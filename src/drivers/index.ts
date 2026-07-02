import type { Driver } from "./types.js";
import type { SafetyConfig } from "../guard.js";
import { SqliteDriver } from "./sqlite.js";

export type DriverKind = "sqlite";

export function createDriver(
  kind: DriverKind,
  connection: string,
  safety: SafetyConfig,
): Driver {
  switch (kind) {
    case "sqlite":
      return new SqliteDriver(connection, safety);
    default:
      throw new Error(`Unsupported database kind: ${kind}`);
  }
}
