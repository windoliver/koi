import { describe, expect, test } from "bun:test";
import { probeManifest } from "../../probes/manifest.js";

describe("probeManifest", () => {
  test("maps manifest entries to probe results", () => {
    const results = probeManifest([
      {
        name: "orders-db",
        protocol: "postgres",
        description: "Order database",
        auth: { kind: "connection_string", ref: "ORDERS_DB_URL" },
        allowedHosts: ["db.example.com"],
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("manifest");
    expect(results[0]?.descriptor).toEqual({
      name: "orders-db",
      protocol: "postgres",
      description: "Order database",
      auth: { kind: "connection_string", ref: "ORDERS_DB_URL" },
      allowedHosts: ["db.example.com"],
    });
  });

  test("handles entries without auth", () => {
    const results = probeManifest([{ name: "cache", protocol: "http" }]);

    expect(results).toHaveLength(1);
    expect(results[0]?.descriptor.auth).toBeUndefined();
    expect(results[0]?.descriptor.allowedHosts).toBeUndefined();
  });

  test("returns empty array for undefined entries", () => {
    expect(probeManifest(undefined)).toEqual([]);
  });

  test("returns empty array for empty entries", () => {
    expect(probeManifest([])).toEqual([]);
  });
});
