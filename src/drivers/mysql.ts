import type {
  Driver,
  ForeignKey,
  IndexHealth,
  IndexHealthReport,
  QueryResult,
  SlowQueryReport,
  TableSchema,
  TableStats,
} from "./types.js";
import {
  capBytes,
  capRows,
  filterTables,
  isColumnHidden,
  isTableAllowed,
  maskRows,
  mentionsRestricted,
  redactRows,
  sanitizeQuery,
  truncateCells,
  visibleColumns,
  visibleForeignKeys,
  visibleIndexes,
  visiblePrimaryKey,
  type SafetyConfig,
} from "../guard.js";
import { markDuplicates } from "./perf.js";

type Rows = { rows: Record<string, unknown>[] };
type Runner = (text: string, params?: unknown[]) => Promise<Rows>;

export interface MySqlClient {
  query(text: string, params?: unknown[]): Promise<Rows>;
  session<T>(fn: (run: Runner) => Promise<T>): Promise<T>;
}

export interface MySqlOptions {
  statementTimeoutMs: number;
  maxCost: number;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export class MySqlDriver implements Driver {
  constructor(
    private readonly client: MySqlClient,
    private readonly safety: SafetyConfig,
    private readonly options: MySqlOptions,
    private readonly closer: () => Promise<void>,
  ) {}

  async listTables(): Promise<string[]> {
    const { rows } = await this.client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_name",
    );
    return filterTables(
      rows.map((row) => String(row.table_name ?? row.TABLE_NAME)),
      this.safety,
    );
  }

  async describeTable(table: string): Promise<TableSchema> {
    if (!isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columnRows = await this.fetchColumns(table);
    if (columnRows.length === 0) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columns = columnRows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
    }));
    return {
      columns: visibleColumns(columns, this.safety),
      primaryKey: visiblePrimaryKey(await this.fetchPrimaryKey(table), this.safety),
      foreignKeys: visibleForeignKeys(await this.fetchForeignKeys(table), this.safety),
      rowCount: await this.estimateRowCount(table),
    };
  }

  async runQuery(sql: string): Promise<QueryResult> {
    const { sql: statement, rowCap } = sanitizeQuery(sql, this.safety);
    const start = Date.now();
    const raw = await this.readOnly(async (run) => {
      await this.enforceCost(run, statement);
      const result = await run(statement);
      return result.rows;
    });
    const elapsedMs = Date.now() - start;
    const capped = capRows(raw, rowCap);
    const shaped = truncateCells(
      maskRows(redactRows(capped.rows, this.safety), this.safety.maskedColumns),
      this.safety.maxCellChars,
    );
    const limited = capBytes(shaped, this.safety.maxResultBytes);
    return {
      rowCount: limited.rows.length,
      truncated: capped.truncated || limited.truncated,
      rows: limited.rows,
      elapsedMs,
    };
  }

  async explainQuery(sql: string): Promise<unknown> {
    const { sql: statement } = sanitizeQuery(sql, this.safety);
    return this.readOnly(async (run) => {
      const { rows } = await run(`EXPLAIN FORMAT=JSON ${statement}`);
      const plan = parsePlan(rows[0]);
      return { totalCost: extractCost(plan), plan };
    });
  }

  async countRows(table: string): Promise<number> {
    if (!isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columns = await this.fetchColumns(table);
    if (columns.length === 0) {
      throw new Error(`Unknown table: ${table}`);
    }
    const rows = await this.readOnly(async (run) => {
      const result = await run(`SELECT count(*) AS count FROM ${quoteIdent(table)}`);
      return result.rows;
    });
    return Number((rows[0] as { count: string | number }).count);
  }

  async columnStats(table: string): Promise<TableStats> {
    if (!isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columnRows = await this.fetchColumns(table);
    if (columnRows.length === 0) {
      throw new Error(`Unknown table: ${table}`);
    }
    const rowEstimate = await this.estimateRowCount(table);
    const { rows } = await this.client.query(
      `SELECT column_name, MAX(cardinality) AS cardinality
       FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ?
       GROUP BY column_name`,
      [table],
    );
    const cardinalityByColumn = new Map(
      rows.map((row) => [
        String(row.column_name ?? row.COLUMN_NAME).toLowerCase(),
        Number(row.cardinality ?? row.CARDINALITY),
      ]),
    );
    const columns = columnRows
      .filter((row) => !isColumnHidden(row.column_name, this.safety))
      .map((row) => {
        const cardinality = cardinalityByColumn.get(row.column_name.toLowerCase());
        if (cardinality === undefined || !Number.isFinite(cardinality)) {
          return {
            column: row.column_name,
            type: row.data_type,
            distinctValues: null,
            nullFraction: null,
            note: "not indexed; MySQL only tracks cardinality for indexed columns",
          };
        }
        return {
          column: row.column_name,
          type: row.data_type,
          distinctValues: Math.round(cardinality),
          nullFraction: null,
        };
      });
    return {
      table,
      rowEstimate,
      columns,
      notes: ["MySQL cardinality comes from index statistics; null fractions are not tracked."],
    };
  }

  async indexHealth(table?: string): Promise<IndexHealthReport> {
    if (table !== undefined && !isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const tableFilter = table === undefined ? "" : "AND table_name = ?";
    const params = table === undefined ? [] : [table];
    const { rows } = await this.client.query(
      `SELECT table_name, index_name, MAX(non_unique) AS non_unique,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS column_list
       FROM information_schema.statistics
       WHERE table_schema = DATABASE() ${tableFilter}
       GROUP BY table_name, index_name
       ORDER BY table_name, index_name`,
      params,
    );
    const indexes: IndexHealth[] = [];
    for (const row of rows) {
      const tableName = String(row.table_name ?? row.TABLE_NAME);
      const indexName = String(row.index_name ?? row.INDEX_NAME);
      const columns = String(row.column_list ?? row.COLUMN_LIST ?? "")
        .split(",")
        .filter((column) => column.length > 0);
      indexes.push({
        index: indexName,
        table: tableName,
        columns,
        unique: Number(row.non_unique ?? row.NON_UNIQUE) === 0,
        primary: indexName === "PRIMARY",
        sizeBytes: null,
        scans: null,
        issues: [],
      });
    }
    const visible = visibleIndexes(indexes, this.safety);
    markDuplicates(visible);
    const notes = [
      "MySQL index sizes are not reported per index; scan counts require performance_schema.",
    ];
    await this.applyUnusedIndexInfo(visible, notes);
    return { indexes: visible, notes };
  }

  async slowQueries(limit = 10): Promise<SlowQueryReport> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    let rows: Record<string, unknown>[];
    try {
      ({ rows } = await this.client.query(
        `SELECT DIGEST_TEXT AS query, COUNT_STAR AS calls,
                SUM_TIMER_WAIT / 1e9 AS total_ms, AVG_TIMER_WAIT / 1e9 AS mean_ms,
                SUM_ROWS_SENT AS row_count
         FROM performance_schema.events_statements_summary_by_digest
         WHERE SCHEMA_NAME = DATABASE() AND DIGEST_TEXT IS NOT NULL
         ORDER BY SUM_TIMER_WAIT DESC
         LIMIT ?`,
        [capped * 3],
      ));
    } catch {
      throw new Error(
        "slow_queries needs the performance_schema statement digests, which are not accessible on this server.",
      );
    }
    const queries = rows
      .filter((row) => !mentionsRestricted(String(row.query ?? ""), this.safety))
      .slice(0, capped)
      .map((row) => ({
        query: String(row.query),
        calls: Number(row.calls),
        totalMs: Math.round(Number(row.total_ms) * 10000) / 10000,
        meanMs: Math.round(Number(row.mean_ms) * 10000) / 10000,
        rows: row.row_count === null ? null : Number(row.row_count),
      }));
    return {
      queries,
      notes: [
        "Times come from performance_schema statement digests; literals are normalized. Statements touching restricted tables or columns are omitted. Counters reset when the server restarts.",
      ],
    };
  }

  private async applyUnusedIndexInfo(indexes: IndexHealth[], notes: string[]): Promise<void> {
    try {
      const { rows } = await this.client.query(
        "SELECT object_name, index_name FROM sys.schema_unused_indexes WHERE object_schema = DATABASE()",
      );
      const unused = new Set(
        rows.map(
          (row) =>
            `${String(row.object_name ?? row.OBJECT_NAME)}::${String(row.index_name ?? row.INDEX_NAME)}`.toLowerCase(),
        ),
      );
      for (const index of indexes) {
        if (unused.has(`${index.table}::${index.index}`.toLowerCase())) {
          index.scans = 0;
          index.issues.push("unused: never scanned since the server started");
        }
      }
      notes.push("Unused-index detection comes from sys.schema_unused_indexes (resets on server restart).");
    } catch {
      notes.push("sys.schema_unused_indexes is not accessible, so unused-index detection was skipped.");
    }
  }

  async close(): Promise<void> {
    await this.closer();
  }

  private async readOnly<T>(fn: (run: Runner) => Promise<T>): Promise<T> {
    return this.client.session(async (run) => {
      if (this.options.statementTimeoutMs > 0) {
        await run(`SET SESSION max_execution_time = ${this.options.statementTimeoutMs}`);
      }
      await run("START TRANSACTION READ ONLY");
      try {
        const result = await fn(run);
        await run("COMMIT");
        return result;
      } catch (error) {
        await run("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  private async enforceCost(run: Runner, statement: string): Promise<void> {
    if (this.options.maxCost <= 0) {
      return;
    }
    const { rows } = await run(`EXPLAIN FORMAT=JSON ${statement}`);
    const cost = extractCost(parsePlan(rows[0]));
    if (cost !== undefined && cost > this.options.maxCost) {
      throw new Error(
        `Query rejected: estimated cost ${Math.round(cost)} exceeds the limit of ${this.options.maxCost}. Narrow the query (add filters or a smaller range).`,
      );
    }
  }

  private async fetchColumns(table: string): Promise<ColumnRow[]> {
    const { rows } = await this.client.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position",
      [table],
    );
    return rows.map((row) => ({
      column_name: String(row.column_name ?? row.COLUMN_NAME),
      data_type: String(row.data_type ?? row.DATA_TYPE),
      is_nullable: String(row.is_nullable ?? row.IS_NULLABLE),
    }));
  }

  private async fetchPrimaryKey(table: string): Promise<string[]> {
    const { rows } = await this.client.query(
      `SELECT column_name FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY'
       ORDER BY ordinal_position`,
      [table],
    );
    return rows.map((row) => String(row.column_name ?? row.COLUMN_NAME));
  }

  private async fetchForeignKeys(table: string): Promise<ForeignKey[]> {
    const { rows } = await this.client.query(
      `SELECT column_name, referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [table],
    );
    return rows.map((row) => ({
      column: String(row.column_name ?? row.COLUMN_NAME),
      referencesTable: String(row.referenced_table_name ?? row.REFERENCED_TABLE_NAME),
      referencesColumn: String(row.referenced_column_name ?? row.REFERENCED_COLUMN_NAME),
    }));
  }

  private async estimateRowCount(table: string): Promise<number | null> {
    const { rows } = await this.client.query(
      "SELECT table_rows FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
      [table],
    );
    if (rows.length === 0) {
      return null;
    }
    const value = Number((rows[0] as { table_rows?: unknown }).table_rows ?? (rows[0] as { TABLE_ROWS?: unknown }).TABLE_ROWS);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
}

function parsePlan(row: unknown): unknown {
  const value = (row as Record<string, unknown>)?.EXPLAIN ?? (row as Record<string, unknown>)?.explain;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function extractCost(plan: unknown): number | undefined {
  const block = (plan as { query_block?: { cost_info?: { query_cost?: string } } })?.query_block;
  const cost = block?.cost_info?.query_cost;
  if (cost === undefined) {
    return undefined;
  }
  const parsed = Number(cost);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}
