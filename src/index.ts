#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDatabasePath } from "./config.js";
import { openDatabase } from "./db.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const db = openDatabase(resolveDatabasePath());
  const server = createServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`dbridge-mcp: ${(error as Error).message}\n`);
  process.exit(1);
});
