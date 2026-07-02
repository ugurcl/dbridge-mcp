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
| `describe_table` | Return a table's columns and types. |
| `sample_table` | Preview the first rows of a table. |
| `run_query` | Run a single read-only `SELECT` / `WITH` and return rows as JSON. |

## Resources

| Resource | Purpose |
| --- | --- |
| `dbridge://schema` | The full schema (every table and its columns) as one JSON document. |

## Safety

- The connection is opened read-only.
- Only `SELECT` and `WITH` statements pass; writes and DDL are rejected.
- A single statement per call; results are capped (default 1000 rows).
- Restricted columns can be hidden entirely: the model cannot see them in the schema, query them, or receive them in results.

### Safety config

Point `DBRIDGE_CONFIG` at a JSON file to tune the guard:

```json
{
  "maxRows": 500,
  "hiddenColumns": ["maas", "tc_kimlik", "parola"]
}
```

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
