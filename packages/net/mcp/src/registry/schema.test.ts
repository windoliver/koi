import { describe, expect, test } from "bun:test";
import { registrySearchResponseSchema, registryServerSchema } from "./schema.js";

describe("registryServerSchema", () => {
  test("parses a minimal server entry", () => {
    const parsed = registryServerSchema.parse({
      name: "io.example/foo",
      description: "Example server",
      version: "1.0.0",
    });
    expect(parsed.name).toBe("io.example/foo");
    expect(parsed.description).toBe("Example server");
    expect(parsed.version).toBe("1.0.0");
  });

  test("parses a full server entry with packages and remotes", () => {
    const parsed = registryServerSchema.parse({
      name: "io.example/full",
      description: "Full",
      version: "2.1.0",
      title: "Full Example",
      websiteUrl: "https://example.com",
      packages: [
        {
          registryType: "npm",
          identifier: "@example/mcp",
          version: "2.1.0",
          transport: { type: "stdio" },
        },
      ],
      remotes: [{ url: "https://mcp.example.com/v1", transport: { type: "http" } }],
      status: "active",
    });
    expect(parsed.packages?.[0]?.registryType).toBe("npm");
    expect(parsed.remotes?.[0]?.url).toBe("https://mcp.example.com/v1");
  });

  test("rejects when required fields missing", () => {
    expect(() => registryServerSchema.parse({ description: "x", version: "1" })).toThrow();
    expect(() => registryServerSchema.parse({ name: "x", version: "1" })).toThrow();
  });

  test("ignores unknown top-level fields (forward compatible)", () => {
    const parsed = registryServerSchema.parse({
      name: "io.example/x",
      description: "x",
      version: "1.0.0",
      futureField: { something: "new" },
    });
    expect(parsed.name).toBe("io.example/x");
  });
});

describe("registrySearchResponseSchema", () => {
  test("parses an empty result set", () => {
    const parsed = registrySearchResponseSchema.parse({ servers: [] });
    expect(parsed.servers).toEqual([]);
  });

  test("parses metadata with nextCursor", () => {
    const parsed = registrySearchResponseSchema.parse({
      servers: [{ name: "io.example/a", description: "a", version: "1.0.0" }],
      metadata: { count: 1, nextCursor: "tok-123" },
    });
    expect(parsed.metadata?.nextCursor).toBe("tok-123");
  });
});
