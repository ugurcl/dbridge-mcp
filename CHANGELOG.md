# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.8.0]

### Added

- `column_stats` tool: per-column distinct-value counts and null fractions
  (PostgreSQL `pg_stats`, MySQL index cardinality, SQLite bounded scan),
  respecting hidden-column rules.
- `index_health` tool: per-index columns, size, and scan counts with
  unused / duplicate / invalid flags (PostgreSQL `pg_stat_user_indexes`,
  MySQL `information_schema` + `sys.schema_unused_indexes`, SQLite PRAGMAs).
- `test_index` tool (PostgreSQL, requires the `hypopg` extension): simulates a
  `CREATE INDEX` hypothetically inside the read-only transaction and reports
  whether the planner would use it, with before/after cost estimates. The
  index definition passes the same guard as queries (blocked tables and
  hidden columns are rejected).

## [0.7.1]

### Added

- MCP Registry metadata (`server.json`, `mcpName`) for the official registry
  listing.
- README: demo gif, comparison section, Cursor and Windsurf setup.

### Changed

- Demo database and documentation examples are now in English
  (`products`, `customers`, `sales`).

## [0.7.0]

### Added

- MySQL / MariaDB driver, selected from `mysql://` connection strings.
- Integration test suite for MySQL, gated on `MYSQL_TEST_URL` so it is skipped
  when no MySQL server is available.

## [0.6.0]

### Added

- `describe_table` now returns the primary key, foreign keys, and a row-count
  estimate alongside the columns.
- `run_query` and `sample_table` accept a `format` argument: `json`, `csv`, or
  `markdown`.
- `maxCellChars` truncates long cell values; `maxResultBytes` caps the total
  result size.

## [0.5.0]

### Added

- Per-setting overrides via `DBRIDGE_*` environment variables and `--flags`
  (precedence: defaults < file < env < cli).
- Column masking (`maskedColumns`) with `partial`, `email`, and `full`
  strategies.
- Query cost guard (`maxCost`) that rejects queries whose `EXPLAIN` estimate is
  too high (PostgreSQL/MySQL).
- Rate limiting (`rateLimitPerMin`) on query-executing tools.
- New tools: `explain_query`, `count_rows`, `get_limits`.

## [0.4.0]

### Added

- Production hardening: enforced row cap over user `LIMIT`, blocked system
  catalogs and credential tables, PostgreSQL `READ ONLY` transactions with
  `statement_timeout`, connection pool limits, optional SSL, and
  `allowedTables` / `blockedTables` access control.
- Opt-in audit logging to stderr and per-query elapsed time.

## [0.3.0]

### Added

- PostgreSQL driver with connection-string detection.

## [0.2.0]

### Added

- Driver modules and the read-only safety guard.

## [0.1.0]

### Added

- Initial MCP server for SQLite with `list_tables`, `describe_table`,
  `sample_table`, and `run_query`.
