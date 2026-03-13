/**
 * HTTP/GraphQL strategy for data source skill generation.
 *
 * Only activates with OpenAPI spec or GraphQL introspection.
 * Does NOT activate from bare URLs.
 */

import type { DataSourceDescriptor } from "@koi/core";
import type { ForgeSkillInput } from "@koi/forge-types";
import type { SkillStrategy } from "../types.js";

export function createHttpStrategy(): SkillStrategy {
  return {
    protocol: "http",
    generateInput(descriptor: DataSourceDescriptor): ForgeSkillInput {
      const credentialRef = descriptor.auth?.ref;

      const body = [
        `# ${descriptor.name} — HTTP API Data Source`,
        "",
        descriptor.description ?? "HTTP API endpoint.",
        ...(descriptor.endpoint !== undefined ? [`\nEndpoint: ${descriptor.endpoint}`] : []),
        "",
        "## Usage",
        "",
        'Use `query_datasource` with `protocol: "http"` to make requests.',
        ...(descriptor.allowedHosts !== undefined
          ? ["", `Allowed hosts: ${descriptor.allowedHosts.join(", ")}`]
          : []),
      ].join("\n");

      return {
        kind: "skill",
        name: `datasource-${descriptor.name}`,
        description: `Data access patterns for ${descriptor.name} (HTTP)`,
        tags: ["datasource", "http", descriptor.name],
        body,
        ...(credentialRef !== undefined
          ? {
              requires: {
                network: true,
                credentials: {
                  [descriptor.name]: {
                    kind: descriptor.auth?.kind ?? "bearer_token",
                    ref: credentialRef,
                  },
                },
              },
            }
          : { requires: { network: true } }),
      };
    },
  };
}

export function createGraphqlStrategy(): SkillStrategy {
  return {
    protocol: "graphql",
    generateInput(descriptor: DataSourceDescriptor): ForgeSkillInput {
      const credentialRef = descriptor.auth?.ref;

      const body = [
        `# ${descriptor.name} — GraphQL Data Source`,
        "",
        descriptor.description ?? "GraphQL API endpoint.",
        ...(descriptor.endpoint !== undefined ? [`\nEndpoint: ${descriptor.endpoint}`] : []),
        "",
        "## Usage",
        "",
        'Use `query_datasource` with `protocol: "graphql"` to execute queries and mutations.',
        ...(descriptor.allowedHosts !== undefined
          ? ["", `Allowed hosts: ${descriptor.allowedHosts.join(", ")}`]
          : []),
      ].join("\n");

      return {
        kind: "skill",
        name: `datasource-${descriptor.name}`,
        description: `Data access patterns for ${descriptor.name} (GraphQL)`,
        tags: ["datasource", "graphql", descriptor.name],
        body,
        ...(credentialRef !== undefined
          ? {
              requires: {
                network: true,
                credentials: {
                  [descriptor.name]: {
                    kind: descriptor.auth?.kind ?? "bearer_token",
                    ref: credentialRef,
                  },
                },
              },
            }
          : { requires: { network: true } }),
      };
    },
  };
}
