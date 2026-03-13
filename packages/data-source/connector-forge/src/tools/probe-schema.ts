// ---------------------------------------------------------------------------
// Schema introspection types
// ---------------------------------------------------------------------------

export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

export interface SchemaTable {
  readonly name: string;
  readonly schema: string;
  readonly columns: readonly SchemaColumn[];
  readonly foreignKeys?: readonly {
    readonly column: string;
    readonly referencesTable: string;
    readonly referencesColumn: string;
  }[];
}

export interface SchemaProbeResult {
  readonly ok: boolean;
  readonly tables?: readonly SchemaTable[];
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Schema probe queries
// ---------------------------------------------------------------------------

/** SQL queries for schema introspection by protocol. */
export function getSchemaProbeQuery(protocol: string): string | undefined {
  switch (protocol) {
    case "postgres":
      return [
        "SELECT t.table_schema, t.table_name, c.column_name, c.data_type, c.is_nullable",
        "FROM information_schema.tables t",
        "JOIN information_schema.columns c",
        "  ON t.table_name = c.table_name AND t.table_schema = c.table_schema",
        "WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')",
        "ORDER BY t.table_schema, t.table_name, c.ordinal_position",
      ].join("\n");
    case "mysql":
      return [
        "SELECT table_schema, table_name, column_name, data_type, is_nullable",
        "FROM information_schema.columns",
        "WHERE table_schema = DATABASE()",
        "ORDER BY table_name, ordinal_position",
      ].join("\n");
    default:
      return undefined;
  }
}
