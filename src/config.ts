export function resolveDatabasePath(): string {
  const path = process.env.DBRIDGE_DB_PATH ?? process.argv[2];
  if (!path) {
    throw new Error(
      "No database path provided. Set DBRIDGE_DB_PATH or pass a sqlite file path as the first argument.",
    );
  }
  return path;
}
