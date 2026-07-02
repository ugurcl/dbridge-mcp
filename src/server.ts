import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Driver } from "./drivers/types.js";
import type { AuditFn } from "./audit.js";

export function createServer(driver: Driver, audit: AuditFn = () => undefined): McpServer {
  const server = new McpServer({ name: "dbridge-mcp", version: "0.4.0" });

  const run = <T>(tool: string, details: Record<string, unknown>, action: () => Promise<T>) =>
    track(tool, details, audit, action);

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "Lists every table in the connected database. Call this first to discover what data is available.",
      inputSchema: {},
    },
    async () => textResult(await run("list_tables", {}, () => driver.listTables())),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "Returns the columns of a table (name, type, nullability). Use it before writing a query.",
      inputSchema: { table: z.string().describe("Exact table name, e.g. satislar") },
    },
    async ({ table }) =>
      textResult(await run("describe_table", { table }, () => driver.describeTable(table))),
  );

  server.registerTool(
    "sample_table",
    {
      title: "Sample table rows",
      description:
        "Returns the first rows of a table as a quick preview, to understand the data before querying.",
      inputSchema: {
        table: z.string().describe("Exact table name"),
        limit: z.number().int().positive().max(50).optional().describe("Rows to preview, default 10"),
      },
    },
    async ({ table, limit }) =>
      textResult(
        await run("sample_table", { table, limit }, async () => {
          await driver.describeTable(table);
          return driver.runQuery(`SELECT * FROM ${quoteQualified(table)} LIMIT ${limit ?? 10}`);
        }),
      ),
  );

  server.registerTool(
    "run_query",
    {
      title: "Run a read-only SQL query",
      description:
        "Runs a single read-only SELECT or WITH statement and returns the rows as JSON. Writes are rejected and results are capped.",
      inputSchema: {
        sql: z
          .string()
          .describe(
            "A single read-only SELECT or WITH statement, written in the connected database's SQL dialect",
          ),
      },
    },
    async ({ sql }) => textResult(await run("run_query", { sql }, () => driver.runQuery(sql))),
  );

  server.registerResource(
    "schema",
    "dbridge://schema",
    {
      title: "Database schema",
      description: "Every table with its columns, as one JSON document.",
      mimeType: "application/json",
    },
    async (uri) => {
      const tables = await driver.listTables();
      const schema: Record<string, unknown> = {};
      for (const table of tables) {
        schema[table] = await driver.describeTable(table);
      }
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(schema, null, 2) },
        ],
      };
    },
  );

  return server;
}

async function track<T>(
  tool: string,
  details: Record<string, unknown>,
  audit: AuditFn,
  action: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await action();
    audit({ tool, ...details, ok: true, ms: Date.now() - start });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit({ tool, ...details, ok: false, ms: Date.now() - start, error: message });
    throw new Error(message);
  }
}

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function quoteQualified(name: string): string {
  return name
    .split(".")
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(".");
}
