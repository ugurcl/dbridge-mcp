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

export interface Driver {
  listTables(): Promise<string[]>;
  describeTable(table: string): Promise<TableSchema>;
  runQuery(sql: string): Promise<QueryResult>;
  explainQuery(sql: string): Promise<unknown>;
  countRows(table: string): Promise<number>;
  close(): Promise<void>;
}
