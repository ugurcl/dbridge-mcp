import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { describeTable, listTables, runQuery } from "./db.js";

export function createServer(db: DatabaseSync): McpServer {
  const server = new McpServer({ name: "dbridge-mcp", version: "0.1.0" });

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "Lists every table in the connected database. Call this first to discover what data is available.",
      inputSchema: {},
    },
    async () => textResult(listTables(db)),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "Returns the columns of a table (name, type, nullability). Use it before writing a query.",
      inputSchema: { table: z.string().describe("Exact table name, e.g. satislar") },
    },
    async ({ table }) => textResult(describeTable(db, table)),
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a read-only SQL query",
      description:
        "Runs a single read-only SELECT or WITH statement and returns the rows as JSON. Writes are rejected and results are capped at 1000 rows.",
      inputSchema: { sql: z.string().describe("A single SQLite SELECT statement") },
    },
    async ({ sql }) => textResult(runQuery(db, sql)),
  );

  return server;
}

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
