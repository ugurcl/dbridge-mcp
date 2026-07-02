#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createDriver } from "./drivers/index.js";
import { createServer } from "./server.js";
import { createAudit } from "./audit.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const driver = createDriver(config.kind, config.connection, config.safety, config.driver);
  const audit = createAudit(config.driver.auditLog);
  const server = createServer(driver, audit);

  const shutdown = async () => {
    await driver.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`dbridge-mcp: ${(error as Error).message}\n`);
  process.exit(1);
});
