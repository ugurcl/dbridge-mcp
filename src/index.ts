#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createDriver } from "./drivers/index.js";
import { createServer } from "./server.js";
import { createAudit } from "./audit.js";
import { createRateLimiter } from "./rate-limit.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const driver = createDriver(config.kind, config.connection, config.safety, config.driver);
  const audit = createAudit(config.driver.auditLog);
  const limiter = createRateLimiter(config.driver.rateLimitPerMin);
  const server = createServer(driver, { audit, limiter, limits: summarizeLimits(config) });

  const shutdown = async () => {
    await driver.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}

function summarizeLimits(config: ReturnType<typeof loadConfig>): Record<string, unknown> {
  return {
    kind: config.kind,
    maxRows: config.safety.maxRows,
    statementTimeoutMs: config.driver.statementTimeoutMs,
    maxCost: config.driver.maxCost,
    rateLimitPerMin: config.driver.rateLimitPerMin,
    schemas: config.driver.schemas,
    hiddenColumns: config.safety.hiddenColumns,
    maskedColumns: config.safety.maskedColumns.map((spec) => spec.column),
    allowedTables: config.safety.allowedTables,
    blockedTables: config.safety.blockedTables,
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`dbridge-mcp: ${(error as Error).message}\n`);
  process.exit(1);
});
