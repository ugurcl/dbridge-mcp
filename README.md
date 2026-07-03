<p align="center">
  <img src="assets/logo.png" alt="dbridge-mcp" width="260">
</p>

<h1 align="center">dbridge-mcp</h1>

<p align="center">
An <a href="https://modelcontextprotocol.io">MCP</a> server that lets an AI agent query a SQL database in plain language — safely and read-only.
</p>

<p align="center">
  <a href="https://github.com/ugurcl/dbridge-mcp/actions/workflows/ci.yml"><img src="https://github.com/ugurcl/dbridge-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/dbridge-mcp"><img src="https://img.shields.io/npm/v/dbridge-mcp.svg" alt="npm"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg" alt="node >=22.5">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license">
</p>

<p align="center">
  <img src="assets/demo.gif" alt="dbridge-mcp demo: an AI agent answering a question by querying the database" width="720">
</p>

The agent discovers the schema on its own (`list_tables`, `describe_table`), then writes and runs a `SELECT` for whatever the user asks. No hand-written endpoint per question.

Works with **SQLite**, **PostgreSQL**, and **MySQL / MariaDB**.

## Why

A raw LLM cannot know what is inside your database, and web search cannot reach private data. dbridge gives the model a guarded door to that data: it can read and answer, but it cannot write, drop, or leak the whole table.

### Why dbridge and not another database MCP?

There are many database MCP servers. dbridge is built around one idea — **you should be able to point an AI at a real database without holding your breath** — and that shows up as a combination the single-engine servers don't offer:

- **One server, three engines.** SQLite, PostgreSQL, and MySQL/MariaDB behind the same seven tools and the same config. Switch databases by changing the connection string, not the tooling.
- **Read-only twice over.** A SQL guard rejects anything but `SELECT`/`WITH` *and* every query runs inside a database-enforced `READ ONLY` transaction — so even a query that outsmarts the guard cannot write.
- **Column-level privacy.** Hide columns from the model entirely, or mask values (`a***@site.com`) while keeping them queryable. Most servers expose whatever the connection can see.
- **Blast-radius controls.** Row caps enforced over user-supplied `LIMIT`s, per-query timeouts, `EXPLAIN`-based cost rejection for expensive queries, per-minute rate limits, and a capped connection pool.
- **No native build step.** SQLite uses Node's built-in `node:sqlite`, so `npx -y dbridge-mcp` works without a compiler toolchain.
- **Performance insight, not just queries.** `column_stats` and `index_health` give the model real cardinality and index-usage data, and `test_index` simulates an index with hypopg before anyone builds it — so the model's optimization advice is grounded in the actual database instead of guesswork. No more agents adding useless indexes to 60M-row tables.

If all you need is "run SQL from my agent", plenty of servers do that. dbridge is for pointing an agent at data you actually care about.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_tables` | List every table in the database. |
| `describe_table` | Return a table's columns, primary key, foreign keys, and row-count estimate. |
| `sample_table` | Preview the first rows of a table (`json`/`csv`/`markdown`). |
| `count_rows` | Return the exact row count of a table. |
| `run_query` | Run a single read-only `SELECT` / `WITH` and return rows as `json`, `csv`, or `markdown`. |
| `explain_query` | Return a query's plan and estimated cost without running it. |
| `column_stats` | Per-column distinct-value counts and null fractions — is this column selective enough to index? |
| `index_health` | List indexes with sizes and scan counts, flagging unused, duplicate, and invalid ones. |
| `test_index` | Simulate a `CREATE INDEX` without building it and report whether the planner would use it (PostgreSQL, via [hypopg](https://github.com/HypoPG/hypopg)). |
| `get_limits` | Report the safety limits in effect (caps, timeouts, hidden/masked columns). |

## Resources

| Resource | Purpose |
| --- | --- |
| `dbridge://schema` | The full schema (every table and its columns) as one JSON document. |

## Requirements

Node.js 22.5+ (SQLite uses the built-in `node:sqlite`, no native build step).

## Install

The published package ships a `dbridge-mcp` binary, so no clone or build step is needed to use it. Point it at a database with the connection argument:

```bash
npx -y dbridge-mcp demo.db                                  # SQLite (file path)
npx -y dbridge-mcp "postgresql://user:pass@host:5432/mydb"  # PostgreSQL
npx -y dbridge-mcp "mysql://user:pass@host:3306/mydb"       # MySQL / MariaDB
```

The database engine is chosen from the connection string: a file path is SQLite, `postgres://` / `postgresql://` is PostgreSQL, and `mysql://` is MySQL/MariaDB.

Or install it once, globally:

```bash
npm install -g dbridge-mcp
dbridge-mcp "postgresql://user:pass@host:5432/mydb"
```

MCP clients start the server for you as a subprocess — see the client sections below.

> **Windows note:** MCP clients cannot launch `npx` directly on Windows because it is a `.cmd` script. Wrap it with `cmd /c` — use `"command": "cmd"` and put `"/c", "npx", "-y", "dbridge-mcp", "<connection>"` in the args. The examples below use the direct form (macOS/Linux); on Windows add the `cmd /c` prefix.

## Use it in Claude Desktop

Claude Desktop only supports a single global config. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dbridge": {
      "command": "npx",
      "args": ["-y", "dbridge-mcp", "postgresql://user:pass@host:5432/mydb"],
      "env": { "DBRIDGE_CONFIG": "/absolute/path/to/dbridge.config.json" }
    }
  }
}
```

For a local SQLite file, replace the connection string with an absolute path to the `.db` file. Restart Claude Desktop, then ask: _"what were the 5 best-selling products last month?"_

## Use it in Claude Code

Add it to the current project with the CLI:

```bash
claude mcp add dbridge --scope project \
  -e DBRIDGE_CONFIG=/absolute/path/to/dbridge.config.json \
  -- npx -y dbridge-mcp "postgresql://user:pass@host:5432/mydb"
```

`--scope project` writes a shareable `.mcp.json` in the project root; use `--scope user` for a global server or omit it for a private per-project one. The `.mcp.json` looks like:

```json
{
  "mcpServers": {
    "dbridge": {
      "command": "npx",
      "args": ["-y", "dbridge-mcp", "postgresql://user:pass@host:5432/mydb"],
      "env": { "DBRIDGE_CONFIG": "/absolute/path/to/dbridge.config.json" }
    }
  }
}
```

Run `claude` from that directory; approve the project server once, then check it with `/mcp`.

## Use it in Cursor

Add the same `mcpServers` block to `.cursor/mcp.json` in the project root (or `~/.cursor/mcp.json` for all projects), enable the server under **Settings → MCP**, then ask the Agent a question about your data.

## Use it in Windsurf

Add the same `mcpServers` block to `~/.codeium/windsurf/mcp_config.json`, then refresh the server list under **Settings → Cascade → MCP**.

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

## Docker

Build the image and run the server over stdio:

```bash
docker build -t dbridge-mcp .
docker run --rm -i dbridge-mcp "postgresql://user:pass@host:5432/mydb"
```

Mount a config file and point `DBRIDGE_CONFIG` at it:

```bash
docker run --rm -i \
  -v "$PWD/dbridge.config.json:/config.json:ro" \
  -e DBRIDGE_CONFIG=/config.json \
  dbridge-mcp "postgresql://user:pass@host:5432/mydb"
```

## Safety

- The connection is opened read-only. On PostgreSQL and MySQL every query also runs inside a `READ ONLY` transaction, so writes are rejected by the database itself even if a query slips past the guard.
- Only `SELECT` and `WITH` statements pass; writes, DDL, and data-modifying CTEs are rejected.
- A single statement per call; the row cap is enforced even when a query supplies its own larger `LIMIT` (default 1000 rows).
- Each PostgreSQL and MySQL query is bounded by a per-query timeout (`statement_timeout` / `max_execution_time`), so a runaway or expensive query cannot pin the database.
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

Or keep everything in one place: point `DBRIDGE_CONFIG` at a JSON file (see [`dbridge.config.example.json`](dbridge.config.example.json) for a full template). Every field is optional:

```json
{
  "maxRows": 500,
  "hiddenColumns": ["ssn", "password_hash"],
  "maskedColumns": ["iban", { "column": "email", "strategy": "email" }],
  "allowedTables": ["products", "sales", "customers"],
  "blockedTables": ["employees", "audit_log"],
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
| `statementTimeoutMs` | `--statement-timeout-ms` / `DBRIDGE_STATEMENT_TIMEOUT_MS` | `10000` | Per-query timeout (PostgreSQL `statement_timeout`, MySQL `max_execution_time`); `0` disables. |
| `maxCost` | `--max-cost` / `DBRIDGE_MAX_COST` | `0` | Reject queries whose `EXPLAIN` cost estimate exceeds this (PostgreSQL/MySQL); `0` disables. |
| `rateLimitPerMin` | `--rate-limit-per-min` / `DBRIDGE_RATE_LIMIT_PER_MIN` | `0` | Max query-executing tool calls per minute; `0` disables. |
| `maxPoolSize` | `--max-pool-size` / `DBRIDGE_MAX_POOL_SIZE` | `5` | Maximum pooled connections (PostgreSQL/MySQL). |
| `connectionTimeoutMs` | `--connection-timeout-ms` / `DBRIDGE_CONNECTION_TIMEOUT_MS` | `10000` | How long to wait for a connection (PostgreSQL/MySQL). |
| `requireSsl` | `--require-ssl` / `DBRIDGE_REQUIRE_SSL` | `false` | Require a verified TLS connection (PostgreSQL/MySQL). |
| `schemas` | `--schemas` / `DBRIDGE_SCHEMAS` | `["public"]` | PostgreSQL-only: schemas to expose; multiple schemas yield `schema.table` names. |
| `auditLog` | `--audit-log` / `DBRIDGE_AUDIT_LOG` | `false` | Log every tool call (query, rows, duration, errors) as JSON to stderr. |

List values on the command line or in env vars are comma-separated (`--allowed-tables products,sales`).

Engine note: `statementTimeoutMs`, `maxCost`, `maxPoolSize`, `connectionTimeoutMs`, `requireSsl`, and `schemas` apply to the networked engines (PostgreSQL/MySQL). SQLite is a local file, so it ignores them; the row cap, column/table access control, and masking apply to every engine.

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

## Local development

To hack on dbridge itself, clone the repo and build from source:

```bash
npm install
npm run build
npm run seed        # creates demo.db (a small store: products, customers, sales)
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

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
