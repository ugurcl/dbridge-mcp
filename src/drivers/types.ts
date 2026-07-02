export interface Column {
  name: string;
  type: string;
  nullable: boolean;
}

export interface QueryResult {
  rowCount: number;
  truncated: boolean;
  rows: Record<string, unknown>[];
}

export interface Driver {
  listTables(): Promise<string[]>;
  describeTable(table: string): Promise<Column[]>;
  runQuery(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}
