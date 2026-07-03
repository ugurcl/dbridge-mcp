import { createRequire } from "node:module";
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
  const server = new McpServer({ name: "dbridge-mcp", version: PACKAGE_VERSION });

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
          const stats = requireCapability(driver.columnStats, "column_stats").bind(driver);
          limiter.take();
          return stats(table);
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
          const health = requireCapability(driver.indexHealth, "index_health").bind(driver);
          limiter.take();
          return health(table);
        }),
      ),
  );

  server.registerTool(
    "test_index",
    {
      title: "Test a hypothetical index",
      description:
        "Simulates a CREATE INDEX without building it (PostgreSQL with the hypopg extension) and reports whether the planner would use it for a given query, with before/after cost estimates. Use this to validate an index idea before recommending it.",
      inputSchema: {
        index: z
          .string()
          .describe('A single CREATE INDEX statement, e.g. CREATE INDEX ON sales (customer_id)'),
        query: z
          .string()
          .describe("The read-only SELECT the index is supposed to speed up"),
      },
    },
    async ({ index, query }) =>
      textResult(
        await run("test_index", { index, query }, () => {
          const testIndex = requireCapability(driver.testIndex, "test_index").bind(driver);
          limiter.take();
          return testIndex(index, query);
        }),
      ),
  );

  server.registerTool(
    "slow_queries",
    {
      title: "Slowest queries",
      description:
        "Returns the most expensive statements recorded by the database (PostgreSQL pg_stat_statements, MySQL performance_schema), with call counts and total/mean times. Use it to decide what is worth optimizing.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("How many statements to return, default 10"),
      },
    },
    async ({ limit }) =>
      textResult(
        await run("slow_queries", { limit }, () => {
          const slow = requireCapability(driver.slowQueries, "slow_queries").bind(driver);
          limiter.take();
          return slow(limit);
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

  server.registerPrompt(
    "optimize",
    {
      title: "Optimize the database",
      description: "A guided, evidence-based optimization pass over the connected database.",
      argsSchema: {
        focus: z
          .string()
          .optional()
          .describe("Optional focus: a table name or a SQL query to optimize"),
      },
    },
    ({ focus }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Optimize this database using evidence, not guesses. Follow these steps:",
              "1. If slow_queries is available, call it to find the most expensive statements" +
                (focus ? ` (focus on: ${focus})` : "") + ".",
              "2. For each candidate query, call explain_query to inspect the plan and index_health on the involved tables to spot unused or duplicate indexes.",
              "3. Before recommending any new index, call column_stats to check the column is selective enough, then validate the idea with test_index — only recommend indexes the planner would actually use.",
              "4. Report: what is slow, why, and the specific validated changes you recommend (with before/after cost estimates). Never claim an index helps without test_index evidence.",
            ].join("\n"),
          },
        },
      ],
    }),
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

const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version as string;

function requireCapability<T>(method: T | undefined, tool: string): T {
  if (!method) {
    throw new Error(`${tool} is not supported for this database engine.`);
  }
  return method;
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
