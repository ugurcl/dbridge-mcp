# dbridge-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent query a SQL database in plain language — safely and read-only.

The agent discovers the schema on its own (`list_tables`, `describe_table`), then writes and runs a `SELECT` for whatever the user asks. No hand-written endpoint per question.

Works with **SQLite** and **PostgreSQL**.

## Why

A raw LLM cannot know what is inside your database, and web search cannot reach private data. dbridge gives the model a guarded door to that data: it can read and answer, but it cannot write, drop, or leak the whole table.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_tables` | List every table in the database. |
| `describe_table` | Return a table's columns, primary key, foreign keys, and row-count estimate. |
| `sample_table` | Preview the first rows of a table (`json`/`csv`/`markdown`). |
| `count_rows` | Return the exact row count of a table. |
| `run_query` | Run a single read-only `SELECT` / `WITH` and return rows as `json`, `csv`, or `markdown`. |
| `explain_query` | Return a query's plan and estimated cost without running it. |
| `get_limits` | Report the safety limits in effect (caps, timeouts, hidden/masked columns). |

## Resources

| Resource | Purpose |
| --- | --- |
| `dbridge://schema` | The full schema (every table and its columns) as one JSON document. |

## Safety

- The connection is opened read-only. On PostgreSQL every query also runs inside a `READ ONLY` transaction, so writes are rejected by the database itself even if a query slips past the guard.
- Only `SELECT` and `WITH` statements pass; writes, DDL, and data-modifying CTEs are rejected.
- A single statement per call; the row cap is enforced even when a query supplies its own larger `LIMIT` (default 1000 rows).
- Each PostgreSQL query is bounded by a `statement_timeout`, so a runaway or expensive query cannot pin the database.
- System catalogs and credential tables (`information_schema`, `pg_authid`, `sqlite_master`, …) are not queryable; schema discovery goes through the tools.
- Restricted columns can be hidden entirely: the model cannot see them in the schema, query them, or receive them in results.
- Tables can be restricted with an allow-list or block-list; blocked tables are invisible and unqueryable.
- Columns can be masked instead of hidden: they stay visible but values come back partially redacted (e.g. `a***@site.com`).
- Expensive queries can be rejected up front by an `EXPLAIN` cost estimate, and callers can be rate-limited per minute.
- The connection pool size is capped, so dbridge cannot exhaust the database's connections.

### Config

Every setting has three sources, in increasing precedence: a JSON file (`DBRIDGE_CONFIG`), environment variables, then CLI flags. So you can drop the JSON file entirely and set only what you need:

```bash
npx -y dbridge-mcp "postgresql://user:pass@host/db" --max-rows 200 --statement-timeout-ms 3000 --masked-columns email,iban
DBRIDGE_MAX_ROWS=200 DBRIDGE_REQUIRE_SSL=true npx -y dbridge-mcp "postgresql://user:pass@host/db"
```

Or point `DBRIDGE_CONFIG` at a JSON file. Every field is optional:

```json
{
  "maxRows": 500,
  "hiddenColumns": ["tc_kimlik", "parola"],
  "maskedColumns": ["iban", { "column": "email", "strategy": "email" }],
  "allowedTables": ["urunler", "satislar", "musteriler"],
  "blockedTables": ["personel", "audit_log"],
  "statementTimeoutMs": 5000,
  "maxCost": 100000,
  "rateLimitPerMin": 60,
  "maxPoolSize": 5,
  "connectionTimeoutMs": 10000,
  "requireSsl": true,
  "schemas": ["public", "reporting"],
  "auditLog": true
}
```

| Field | CLI flag / env var | Default | Purpose |
| --- | --- | --- | --- |
| `maxRows` | `--max-rows` / `DBRIDGE_MAX_ROWS` | `1000` | Hard cap on rows returned per query, enforced even over a larger `LIMIT`. |
| `hiddenColumns` | `--hidden-columns` / `DBRIDGE_HIDDEN_COLUMNS` | `[]` | Columns hidden from the schema, queries, and results. |
| `maskedColumns` | `--masked-columns` / `DBRIDGE_MASKED_COLUMNS` | `[]` | Columns whose values are redacted in results (see below). |
| `maxCellChars` | `--max-cell-chars` / `DBRIDGE_MAX_CELL_CHARS` | `0` | Truncate any string cell longer than this; `0` disables. |
| `maxResultBytes` | `--max-result-bytes` / `DBRIDGE_MAX_RESULT_BYTES` | `0` | Cap the total serialized result size, dropping trailing rows; `0` disables. |
| `allowedTables` | `--allowed-tables` / `DBRIDGE_ALLOWED_TABLES` | `[]` | If non-empty, only these tables are exposed. |
| `blockedTables` | `--blocked-tables` / `DBRIDGE_BLOCKED_TABLES` | `[]` | Tables that are always hidden and unqueryable. |
| `statementTimeoutMs` | `--statement-timeout-ms` / `DBRIDGE_STATEMENT_TIMEOUT_MS` | `10000` | PostgreSQL per-query timeout; `0` disables. |
| `maxCost` | `--max-cost` / `DBRIDGE_MAX_COST` | `0` | Reject queries whose PostgreSQL `EXPLAIN` cost exceeds this; `0` disables. |
| `rateLimitPerMin` | `--rate-limit-per-min` / `DBRIDGE_RATE_LIMIT_PER_MIN` | `0` | Max query-executing tool calls per minute; `0` disables. |
| `maxPoolSize` | `--max-pool-size` / `DBRIDGE_MAX_POOL_SIZE` | `5` | Maximum PostgreSQL connections. |
| `connectionTimeoutMs` | `--connection-timeout-ms` / `DBRIDGE_CONNECTION_TIMEOUT_MS` | `10000` | How long to wait for a connection. |
| `requireSsl` | `--require-ssl` / `DBRIDGE_REQUIRE_SSL` | `false` | Require a verified TLS connection (PostgreSQL). |
| `schemas` | `--schemas` / `DBRIDGE_SCHEMAS` | `["public"]` | PostgreSQL schemas to expose; multiple schemas yield `schema.table` names. |
| `auditLog` | `--audit-log` / `DBRIDGE_AUDIT_LOG` | `false` | Log every tool call (query, rows, duration, errors) as JSON to stderr. |

List values on the command line or in env vars are comma-separated (`--allowed-tables urunler,satislar`).

### Column masking

`maskedColumns` keeps a column visible but redacts its values. Each entry is either a column name (defaults to the `partial` strategy) or an object `{ "column": ..., "strategy": ..., "keep": ... }`:

| Strategy | Example input | Output |
| --- | --- | --- |
| `partial` (default) | `TR120000123456` | `**********3456` (keeps the last `keep`, default 4) |
| `email` | `ayse@site.com` | `a***@site.com` |
| `full` | anything | `***` |

Unlike `hiddenColumns`, a masked column can still be used in `WHERE`/`GROUP BY`, so use `hiddenColumns` for true secrets and `maskedColumns` for values that should be recognizable but not exposed.

### Output formats

`run_query` and `sample_table` take an optional `format` argument: `json` (default, full result object), `csv`, or `markdown`. CSV and Markdown return a compact table prefixed with a short `rows: N · Nms` header — handy for fewer tokens and readable output. Combine with `maxCellChars` and `maxResultBytes` to keep large results in check.

### Running against a production database

- Pass the connection string via the `DBRIDGE_DB_PATH` environment variable instead of the command line, so the password does not appear in the process list.
- Prefer a dedicated database role with read-only grants on only the tables you want exposed — that is the real security boundary; the guard is defense in depth.
- Set a conservative `statementTimeoutMs`, `maxRows`, and `maxCost`, and use `allowedTables` to expose only reporting tables.

## Requirements

Node.js 22.5+ (SQLite uses the built-in `node:sqlite`, no native build step).

## Install

The published package ships a `dbridge-mcp` binary, so no clone or build step is needed to use it. Point it at a database with the connection argument:

```bash
npx -y dbridge-mcp demo.db                                  # SQLite (file path)
npx -y dbridge-mcp "postgresql://user:pass@host:5432/mydb"  # PostgreSQL
```

Or install it once, globally:

```bash
npm install -g dbridge-mcp
dbridge-mcp "postgresql://user:pass@host:5432/mydb"
```

MCP clients start the server for you as a subprocess — see the client sections below.

## Local development

To hack on dbridge itself, clone the repo and build from source:

```bash
npm install
npm run build
npm run seed        # creates demo.db (a small store: urunler, musteriler, satislar)
node dist/index.js demo.db
```

## Try it with the MCP Inspector

```bash
npm run inspect
```

Then call the tools from the Inspector UI. No LLM or API key needed.

## Tests

```bash
npm test
```

## Use it in Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dbridge": {
      "command": "npx",
      "args": ["-y", "dbridge-mcp", "postgresql://user:pass@host:5432/mydb"]
    }
  }
}
```

For a local SQLite file, replace the connection string with an absolute path to the `.db` file.

Restart Claude Desktop, then ask: _"geçen ay en çok satan 5 ürün ne?"_

## Use it in OpenCode

Add to `opencode.json` (project root or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dbridge": {
      "type": "local",
      "command": ["npx", "-y", "dbridge-mcp", "postgresql://user:pass@host:5432/mydb"],
      "enabled": true
    }
  }
}
```

To tune the safety guard, point the server at a config file with the `environment` block:

```json
"environment": { "DBRIDGE_CONFIG": "/absolute/path/to/dbridge.config.json" }
```

## License

MIT
