export interface Column {
  name: string;
  type: string;
  nullable: boolean;
}

export interface ForeignKey {
  column: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface TableSchema {
  columns: Column[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  rowCount: number | null;
}

export interface QueryResult {
  rowCount: number;
  truncated: boolean;
  rows: Record<string, unknown>[];
  elapsedMs: number;
}

export interface ColumnStats {
  column: string;
  type: string;
  distinctValues: number | null;
  nullFraction: number | null;
  note?: string;
}

export interface TableStats {
  table: string;
  rowEstimate: number | null;
  columns: ColumnStats[];
  notes: string[];
}

export interface IndexHealth {
  index: string;
  table: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  sizeBytes: number | null;
  scans: number | null;
  issues: string[];
}

export interface IndexHealthReport {
  indexes: IndexHealth[];
  notes: string[];
}

export interface Driver {
  listTables(): Promise<string[]>;
  describeTable(table: string): Promise<TableSchema>;
  runQuery(sql: string): Promise<QueryResult>;
  explainQuery(sql: string): Promise<unknown>;
  countRows(table: string): Promise<number>;
  columnStats?(table: string): Promise<TableStats>;
  indexHealth?(table?: string): Promise<IndexHealthReport>;
  close(): Promise<void>;
}
