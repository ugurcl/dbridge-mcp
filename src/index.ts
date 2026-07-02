#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createDriver } from "./drivers/index.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const driver = createDriver(config.kind, config.connection, config.safety);
  const server = createServer(driver);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`dbridge-mcp: ${(error as Error).message}\n`);
  process.exit(1);
});
