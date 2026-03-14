/**
 * Generates a ForgeSkillInput for postgres data sources.
 *
 * Creates a skill that contains:
 * 1. Schema summary section (~200 tokens)
 * 2. Query pattern templates (parameterized only)
 * 3. requires.credentials pointing to the connection string
 */

import type { DataSourceDescriptor } from "@koi/core";
import type { ForgeSkillInput } from "@koi/forge-types";
import type { SkillStrategy } from "../types.js";

export function createPostgresStrategy(): SkillStrategy {
  return {
    protocol: "postgres",
    generateInput(descriptor: DataSourceDescriptor): ForgeSkillInput {
      const credentialRef = descriptor.auth?.ref ?? "DATABASE_URL";

      const body = [
        `# ${descriptor.name} — PostgreSQL Data Access`,
        "",
        descriptor.description ?? "PostgreSQL database connection.",
        "",
        "## Query Patterns",
        "",
        "Always use parameterized queries. Never concatenate user input into SQL.",
        "",
        "```sql",
        "-- Read pattern",
        "SELECT columns FROM table WHERE condition = $1;",
        "",
        "-- Write pattern",
        "INSERT INTO table (col1, col2) VALUES ($1, $2) RETURNING id;",
        "```",
        "",
        "## Tools",
        "",
        'Use `query_datasource` with `protocol: "sql"` and parameterized `params` array.',
        "Use `probe_schema` to discover table structure before writing queries.",
      ].join("\n");

      return {
        kind: "skill",
        name: `datasource-${descriptor.name}`,
        description: `Data access patterns for ${descriptor.name} (PostgreSQL)`,
        tags: ["datasource", "postgres", descriptor.name],
        body,
        requires: {
          network: true,
          credentials: {
            [descriptor.name]: {
              kind: "connection_string",
              ref: credentialRef,
            },
          },
        },
      };
    },
  };
}
