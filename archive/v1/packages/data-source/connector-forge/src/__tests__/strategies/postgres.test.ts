import { describe, expect, test } from "bun:test";
import type { DataSourceDescriptor } from "@koi/core";
import { createPostgresStrategy } from "../../strategies/postgres.js";

describe("createPostgresStrategy", () => {
  const strategy = createPostgresStrategy();

  const descriptor: DataSourceDescriptor = {
    name: "users-db",
    protocol: "postgres",
    description: "User accounts database",
    auth: { kind: "connection_string", ref: "USERS_DB_URL" },
  };

  test("generated skill has requires.credentials with correct ref", () => {
    const input = strategy.generateInput(descriptor);

    expect(input.requires).toBeDefined();
    expect(input.requires?.credentials).toBeDefined();

    const cred = input.requires?.credentials?.["users-db"];
    expect(cred).toBeDefined();
    expect(cred?.kind).toBe("connection_string");
    expect(cred?.ref).toBe("USERS_DB_URL");
  });

  test("generated skill body mentions parameterized queries", () => {
    const input = strategy.generateInput(descriptor);

    expect(input.body).toContain("parameterized queries");
    expect(input.body).toContain("$1");
  });

  test("generated skill has datasource tag", () => {
    const input = strategy.generateInput(descriptor);

    expect(input.tags).toContain("datasource");
    expect(input.tags).toContain("postgres");
    expect(input.tags).toContain("users-db");
  });

  test("falls back to DATABASE_URL when no auth ref provided", () => {
    const noAuth: DataSourceDescriptor = {
      name: "local-db",
      protocol: "postgres",
    };

    const input = strategy.generateInput(noAuth);

    const cred = input.requires?.credentials?.["local-db"];
    expect(cred?.ref).toBe("DATABASE_URL");
  });
});
