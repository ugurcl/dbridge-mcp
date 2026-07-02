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
      "command": "node",
      "args": ["ABSOLUTE/PATH/dbridge-mcp/dist/index.js", "ABSOLUTE/PATH/dbridge-mcp/demo.db"]
    }
  }
}
```

Restart Claude Desktop, then ask: _"geçen ay en çok satan 5 ürün ne?"_

## License

MIT
