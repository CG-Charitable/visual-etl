import { prisma } from "../prisma.ts";

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: "table" | "view";
  columns: ColumnInfo[];
}

interface IntrospectionRow {
  table_schema: string;
  table_name: string;
  table_type: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

let cache: TableInfo[] | null = null;

async function loadIntrospection(): Promise<TableInfo[]> {
  const rows = await prisma.$queryRawUnsafe<IntrospectionRow[]>(`
    SELECT
      c.table_schema,
      c.table_name,
      t.table_type,
      c.column_name,
      c.data_type,
      c.is_nullable
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
  `);

  const tableMap = new Map<string, TableInfo>();
  for (const row of rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    let table = tableMap.get(key);
    if (!table) {
      table = {
        schema: row.table_schema,
        name: row.table_name,
        type: row.table_type === "VIEW" ? "view" : "table",
        columns: [],
      };
      tableMap.set(key, table);
    }
    table.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
    });
  }

  return [...tableMap.values()];
}

export async function getIntrospection(): Promise<TableInfo[]> {
  if (!cache) cache = await loadIntrospection();
  return cache;
}

export async function refreshIntrospection(): Promise<TableInfo[]> {
  cache = await loadIntrospection();
  return cache;
}
