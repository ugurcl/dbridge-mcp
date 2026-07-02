import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Driver, QueryResult } from "./drivers/types.js";
import type { AuditFn } from "./audit.js";
import type { RateLimiter } from "./rate-limit.js";
import { toCsv, toMarkdown, type OutputFormat } from "./format.js";

export interface ServerDeps {
  audit?: AuditFn;
  limiter?: RateLimiter;
  limits?: Record<string, unknown>;
}

export function createServer(driver: Driver, deps: ServerDeps = {}): McpServer {
  const audit = deps.audit ?? (() => undefined);
  const limiter = deps.limiter ?? { take: () => undefined };
  const limits = deps.limits ?? {};
  const server = new McpServer({ name: "dbridge-mcp", version: "0.8.0" });

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
      inputSchema: { table: z.string().describe("Exact table name, e.g. sales") },
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
        format: FORMAT_SCHEMA,
      },
    },
    async ({ table, limit, format }) => {
      const result = await run("sample_table", { table, limit, format }, async () => {
        limiter.take();
        await driver.describeTable(table);
        return driver.runQuery(`SELECT * FROM ${quoteQualified(table)} LIMIT ${limit ?? 10}`);
      });
      return formatResult(result, format);
    },
  );

  server.registerTool(
    "count_rows",
    {
      title: "Count table rows",
      description: "Returns the exact number of rows in a table.",
      inputSchema: { table: z.string().describe("Exact table name") },
    },
    async ({ table }) =>
      textResult(
        await run("count_rows", { table }, () => {
          limiter.take();
          return driver.countRows(table).then((count) => ({ table, count }));
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
        format: FORMAT_SCHEMA,
      },
    },
    async ({ sql, format }) => {
      const result = await run("run_query", { sql, format }, () => {
        limiter.take();
        return driver.runQuery(sql);
      });
      return formatResult(result, format);
    },
  );

  server.registerTool(
    "explain_query",
    {
      title: "Explain a query",
      description:
        "Returns the query plan and estimated cost without running the query. Use it to check a query is cheap before running it.",
      inputSchema: {
        sql: z.string().describe("A single read-only SELECT or WITH statement to analyze"),
      },
    },
    async ({ sql }) => textResult(await run("explain_query", { sql }, () => driver.explainQuery(sql))),
  );

  server.registerTool(
    "column_stats",
    {
      title: "Column statistics",
      description:
        "Returns per-column cardinality (distinct values) and null fraction for a table. Use it to judge whether a column is selective enough to be worth indexing or grouping by.",
      inputSchema: { table: z.string().describe("Exact table name") },
    },
    async ({ table }) =>
      textResult(
        await run("column_stats", { table }, () => {
          if (!driver.columnStats) {
            throw new Error("column_stats is not supported for this database engine.");
          }
          limiter.take();
          return driver.columnStats(table);
        }),
      ),
  );

  server.registerTool(
    "index_health",
    {
      title: "Index health",
      description:
        "Lists indexes with their columns, size, and scan counts, flagging unused, duplicate, and invalid indexes. Use it to spot dead weight before recommending a new index.",
      inputSchema: {
        table: z.string().optional().describe("Limit the report to one table; omit for all tables"),
      },
    },
    async ({ table }) =>
      textResult(
        await run("index_health", { table }, () => {
          if (!driver.indexHealth) {
            throw new Error("index_health is not supported for this database engine.");
          }
          limiter.take();
          return driver.indexHealth(table);
        }),
      ),
  );

  server.registerTool(
    "get_limits",
    {
      title: "Get active limits",
      description:
        "Returns the safety limits in effect (row cap, timeout, cost/rate limits, hidden and masked columns, table allow/block lists).",
      inputSchema: {},
    },
    async () => textResult(await run("get_limits", {}, async () => limits)),
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

const FORMAT_SCHEMA = z
  .enum(["json", "csv", "markdown"])
  .optional()
  .describe("Output format for the rows: json (default), csv, or markdown");

function formatResult(result: QueryResult, format: OutputFormat | undefined) {
  if (!format || format === "json") {
    return textResult(result);
  }
  const table = format === "csv" ? toCsv(result.rows) : toMarkdown(result.rows);
  const header = `rows: ${result.rowCount}${result.truncated ? " (truncated)" : ""} · ${result.elapsedMs}ms`;
  return { content: [{ type: "text" as const, text: `${header}\n\n${table}` }] };
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
