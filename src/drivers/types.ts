export interface Column {
  name: string;
  type: string;
  nullable: boolean;
}

export interface QueryResult {
  rowCount: number;
  truncated: boolean;
  rows: Record<string, unknown>[];
  elapsedMs: number;
}

export interface Driver {
  listTables(): Promise<string[]>;
  describeTable(table: string): Promise<Column[]>;
  runQuery(sql: string): Promise<QueryResult>;
  explainQuery(sql: string): Promise<unknown>;
  countRows(table: string): Promise<number>;
  close(): Promise<void>;
}
