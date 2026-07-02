# dbridge-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent query a SQL database in plain language — safely and read-only.

The agent discovers the schema on its own (`list_tables`, `describe_table`), then writes and runs a `SELECT` for whatever the user asks. No hand-written endpoint per question.

## Why

A raw LLM cannot know what is inside your database, and web search cannot reach private data. dbridge gives the model a guarded door to that data: it can read and answer, but it cannot write, drop, or leak the whole table.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_tables` | List every table in the database. |
| `describe_table` | Return a table's columns and types. |
| `run_query` | Run a single read-only `SELECT` / `WITH` and return rows as JSON. |

## Safety

- The connection is opened read-only.
- Only `SELECT` and `WITH` statements pass; writes and DDL are rejected.
- A single statement per call; results are capped at 1000 rows.

## Requirements

Node.js 22.5+ (uses the built-in `node:sqlite`). No native build step.

## Setup

```bash
npm install
npm run build
npm run seed        # creates demo.db (a small store: urunler, musteriler, satislar)
```

## Try it with the MCP Inspector

```bash
npm run inspect
```

Then call `list_tables`, `describe_table`, and `run_query` from the Inspector UI. No LLM or API key needed.

## Use it in Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dbridge": {
      "command": "node",
      "args": ["ABSOLUTE/PATH/dbridge-mcp/dist/index.js", "ABSOLUTE/PATH/dbridge-mcp/demo.db"]
    }
  }
}
```

Restart Claude Desktop, then ask: _"geçen ay en çok satan 5 ürün ne?"_

## License

MIT
