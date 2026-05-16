import { describe, expect, test } from "bun:test";

import { mapRemotePermissions } from "./index.js";

describe("mapRemotePermissions", () => {
  test("maps configured remote permissions to local permission queries", () => {
    const result = mapRemotePermissions(
      ["remote:read", "remote:write"],
      [
        { remote: "remote:read", action: "read_file", resource: "workspace:*" },
        { remote: "remote:write", action: "write_file" },
      ],
    );

    expect(result).toEqual({
      ok: true,
      queries: [
        {
          principal: "remote",
          action: "read_file",
          resource: "workspace:*",
          context: { remotePermission: "remote:read" },
        },
        {
          principal: "remote",
          action: "write_file",
          resource: "*",
          context: { remotePermission: "remote:write" },
        },
      ],
    });
  });

  test("unknown remote permission rejects with unknown_permission", () => {
    const result = mapRemotePermissions(
      ["remote:read", "remote:admin"],
      [{ remote: "remote:read", action: "read_file", resource: "workspace:*" }],
    );

    expect(result).toEqual({
      ok: false,
      reason: "unknown_permission",
      permission: "remote:admin",
    });
  });
});
