import type {
  Driver,
  ForeignKey,
  IndexHealth,
  IndexHealthReport,
  IndexTestResult,
  QueryResult,
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
  redactRows,
  sanitizeIndexDefinition,
  sanitizeQuery,
  truncateCells,
  visibleColumns,
  visibleForeignKeys,
  visibleIndexes,
  visiblePrimaryKey,
  type SafetyConfig,
} from "../guard.js";
import { markDuplicates, round4 } from "./perf.js";

type Rows = { rows: Record<string, unknown>[] };
type Runner = (text: string, params?: unknown[]) => Promise<Rows>;

export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<Rows>;
  session<T>(fn: (run: Runner) => Promise<T>): Promise<T>;
}

export interface PostgresOptions {
  statementTimeoutMs: number;
  schemas: string[];
  maxCost: number;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export class PostgresDriver implements Driver {
  constructor(
    private readonly client: SqlClient,
    private readonly safety: SafetyConfig,
    private readonly options: PostgresOptions,
    private readonly closer: () => Promise<void>,
  ) {}

  async listTables(): Promise<string[]> {
    const { rows } = await this.client.query(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = ANY($1) AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_schema, table_name",
      [this.options.schemas],
    );
    const qualify = this.options.schemas.length > 1;
    const names = rows.map((row) =>
      qualify ? `${String(row.table_schema)}.${String(row.table_name)}` : String(row.table_name),
    );
    return filterTables(names, this.safety);
  }

  async describeTable(table: string): Promise<TableSchema> {
    if (!isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const rows = await this.fetchColumns(table);
    if (rows.length === 0) {
      throw new Error(`Unknown table: ${table}`);
    }
    const columns = rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
    }));
    const { schema, name } = await this.splitQualified(table);
    return {
      columns: visibleColumns(columns, this.safety),
      primaryKey: visiblePrimaryKey(await this.fetchPrimaryKey(schema, name), this.safety),
      foreignKeys: visibleForeignKeys(await this.fetchForeignKeys(schema, name), this.safety),
      rowCount: await this.estimateRowCount(schema, name),
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
      const plan = await this.fetchPlan(run, statement);
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
      const result = await run(`SELECT count(*)::bigint AS count FROM ${quoteQualified(table)}`);
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
    const { schema, name } = await this.splitQualified(table);
    const [rowEstimate, { rows: statRows }] = await Promise.all([
      this.estimateRowCount(schema, name),
      this.client.query(
        "SELECT attname, n_distinct, null_frac FROM pg_stats WHERE schemaname = $1 AND tablename = $2",
        [schema, name],
      ),
    ]);
    const statsByColumn = new Map(
      statRows.map((row) => [
        String(row.attname),
        { nDistinct: Number(row.n_distinct), nullFrac: Number(row.null_frac) },
      ]),
    );

    const notes: string[] = [];
    if (statRows.length === 0) {
      notes.push("No planner statistics for this table yet; ask the DBA to run ANALYZE for accurate numbers.");
    }

    const columns = columnRows
      .filter((row) => !isColumnHidden(row.column_name, this.safety))
      .map((row) => {
        const stat = statsByColumn.get(row.column_name);
        if (!stat) {
          return {
            column: row.column_name,
            type: row.data_type,
            distinctValues: null,
            nullFraction: null,
            note: "no statistics",
          };
        }
        return {
          column: row.column_name,
          type: row.data_type,
          distinctValues: normalizeDistinct(stat.nDistinct, rowEstimate),
          nullFraction: Number.isFinite(stat.nullFrac) ? round4(stat.nullFrac) : null,
        };
      });

    return { table, rowEstimate, columns, notes };
  }

  async indexHealth(table?: string): Promise<IndexHealthReport> {
    if (table !== undefined && !isTableAllowed(table, this.safety)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const tableFilter = table === undefined ? "" : "AND s.relname = $2";
    const params: unknown[] = [this.options.schemas];
    if (table !== undefined) {
      params.push((await this.splitQualified(table)).name);
    }
    const { rows } = await this.client.query(
      `SELECT s.relname AS table_name, s.indexrelname AS index_name, s.idx_scan AS scans,
              pg_relation_size(s.indexrelid) AS size_bytes,
              i.indisunique AS is_unique, i.indisprimary AS is_primary, i.indisvalid AS is_valid,
              array_to_string(array(
                SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                ORDER BY k.ord
              ), ',') AS column_list
       FROM pg_stat_user_indexes s
       JOIN pg_index i ON i.indexrelid = s.indexrelid
       WHERE s.schemaname = ANY($1) ${tableFilter}
       ORDER BY s.relname, s.indexrelname`,
      params,
    );

    const indexes: IndexHealth[] = [];
    for (const row of rows) {
      const tableName = String(row.table_name);
      const columns = String(row.column_list ?? "")
        .split(",")
        .filter((column) => column.length > 0);
      const scans = row.scans === null || row.scans === undefined ? null : Number(row.scans);
      const primary = Boolean(row.is_primary);
      const unique = Boolean(row.is_unique);
      const issues: string[] = [];
      if (row.is_valid === false) {
        issues.push("invalid: the index failed to build and is not used by the planner");
      }
      if (scans === 0 && !primary && !unique) {
        issues.push("unused: never scanned since statistics were last reset");
      }
      indexes.push({
        index: String(row.index_name),
        table: tableName,
        columns,
        unique,
        primary,
        sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
        scans,
        issues,
      });
    }
    const visible = visibleIndexes(indexes, this.safety);
    markDuplicates(visible);
    return {
      indexes: visible,
      notes: ["Scan counts come from pg_stat_user_indexes and reset when database statistics are reset."],
    };
  }

  async testIndex(indexSql: string, querySql: string): Promise<IndexTestResult> {
    const { sql: definition } = sanitizeIndexDefinition(indexSql, this.safety);
    const { sql: query } = sanitizeQuery(querySql, this.safety);
    return this.readOnly(async (run) => {
      const { rows: extension } = await run(
        "SELECT 1 FROM pg_extension WHERE extname = 'hypopg'",
      );
      if (extension.length === 0) {
        throw new Error(
          "test_index needs the hypopg extension. Ask the DBA to run: CREATE EXTENSION hypopg;",
        );
      }
      try {
        const planBefore = await this.fetchPlan(run, query);
        const costBefore = extractCost(planBefore) ?? null;

        const { rows: created } = await run("SELECT indexname FROM hypopg_create_index($1)", [
          definition,
        ]);
        const hypoName = String((created[0] as { indexname: string }).indexname);

        const planAfter = await this.fetchPlan(run, query);
        const costAfter = extractCost(planAfter) ?? null;
        const used = JSON.stringify(planAfter).includes(hypoName);

        const improvementPct =
          used && costBefore !== null && costAfter !== null && costBefore > 0
            ? Math.round(((costBefore - costAfter) / costBefore) * 1000) / 10
            : null;
        const verdict = used
          ? `The planner would use this index: estimated cost ${costBefore} -> ${costAfter}` +
            (improvementPct !== null ? ` (${improvementPct}% cheaper).` : ".")
          : "The planner ignores this index for the given query; creating it would not help.";

        return {
          index: definition,
          used,
          costBefore,
          costAfter,
          improvementPct,
          verdict,
          planBefore,
          planAfter,
        };
      } finally {
        await run("SELECT hypopg_reset()").catch(() => undefined);
      }
    });
  }

  private async fetchPlan(run: Runner, query: string): Promise<unknown> {
    const { rows } = await run(`EXPLAIN (FORMAT JSON) ${query}`);
    return (rows[0] as { "QUERY PLAN"?: unknown })["QUERY PLAN"];
  }

  private async splitQualified(table: string): Promise<{ schema: string; name: string }> {
    const dot = table.indexOf(".");
    if (dot !== -1) {
      return { schema: table.slice(0, dot), name: table.slice(dot + 1) };
    }
    return { schema: await this.resolveSchema(table), name: table };
  }

  async close(): Promise<void> {
    await this.closer();
  }

  private async readOnly<T>(fn: (run: Runner) => Promise<T>): Promise<T> {
    return this.client.session(async (run) => {
      await run("BEGIN TRANSACTION READ ONLY");
      try {
        if (this.options.statementTimeoutMs > 0) {
          await run(`SET LOCAL statement_timeout = ${this.options.statementTimeoutMs}`);
        }
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
    const { rows } = await run(`EXPLAIN (FORMAT JSON) ${statement}`);
    const cost = extractCost((rows[0] as { "QUERY PLAN"?: unknown })["QUERY PLAN"]);
    if (cost !== undefined && cost > this.options.maxCost) {
      throw new Error(
        `Query rejected: estimated cost ${Math.round(cost)} exceeds the limit of ${this.options.maxCost}. Narrow the query (add filters or a smaller range).`,
      );
    }
  }

  private async resolveSchema(name: string): Promise<string> {
    const { rows } = await this.client.query(
      "SELECT table_schema FROM information_schema.tables WHERE table_schema = ANY($1) AND table_name = $2 LIMIT 1",
      [this.options.schemas, name],
    );
    return rows.length > 0 ? String(rows[0].table_schema) : this.options.schemas[0];
  }

  private async fetchPrimaryKey(schema: string, name: string): Promise<string[]> {
    const { rows } = await this.client.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
       ORDER BY kcu.ordinal_position`,
      [schema, name],
    );
    return rows.map((row) => String(row.column_name));
  }

  private async fetchForeignKeys(schema: string, name: string): Promise<ForeignKey[]> {
    const { rows } = await this.client.query(
      `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, name],
    );
    return rows.map((row) => ({
      column: String(row.column_name),
      referencesTable: String(row.ref_table),
      referencesColumn: String(row.ref_column),
    }));
  }

  private async estimateRowCount(schema: string, name: string): Promise<number | null> {
    const { rows } = await this.client.query(
      "SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = to_regclass($1)",
      [`${quoteQualified(`${schema}.${name}`)}`],
    );
    if (rows.length === 0) {
      return null;
    }
    const estimate = Number((rows[0] as { estimate: string | number }).estimate);
    return Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
  }

  private async fetchColumns(table: string): Promise<ColumnRow[]> {
    const dot = table.indexOf(".");
    if (dot !== -1) {
      const schema = table.slice(0, dot);
      const name = table.slice(dot + 1);
      const { rows } = await this.client.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
        [schema, name],
      );
      return rows as unknown as ColumnRow[];
    }
    const { rows } = await this.client.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = ANY($1) AND table_name = $2 ORDER BY ordinal_position",
      [this.options.schemas, table],
    );
    return rows as unknown as ColumnRow[];
  }
}

function normalizeDistinct(nDistinct: number, rowEstimate: number | null): number | null {
  if (!Number.isFinite(nDistinct)) {
    return null;
  }
  if (nDistinct >= 0) {
    return Math.round(nDistinct);
  }
  // Negative means "fraction of rows are distinct" (e.g. -1 = all rows unique).
  if (rowEstimate === null || rowEstimate <= 0) {
    return null;
  }
  return Math.round(-nDistinct * rowEstimate);
}

function extractCost(plan: unknown): number | undefined {
  const node = Array.isArray(plan) ? plan[0] : plan;
  if (node && typeof node === "object" && "Plan" in node) {
    const inner = (node as { Plan: { "Total Cost"?: number } }).Plan;
    return typeof inner["Total Cost"] === "number" ? inner["Total Cost"] : undefined;
  }
  return undefined;
}

function quoteQualified(name: string): string {
  return name
    .split(".")
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(".");
}
