import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalServerConfig } from "./config.js";
import { installMcpServer, pickPackageForInstall, uninstallMcpServer } from "./installer.js";
import type { RegistryServer } from "./registry/schema.js";

function tmpFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-install-"));
  return {
    path: join(dir, ".mcp.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const baseServer: RegistryServer = {
  name: "io.example/foo",
  description: "Foo",
  version: "1.0.0",
};

describe("pickPackageForInstall", () => {
  test("prefers http remotes over packages", () => {
    const result = pickPackageForInstall({
      ...baseServer,
      remotes: [{ url: "https://mcp.example.com", transport: { type: "http" } }],
      packages: [{ registryType: "npm", identifier: "@example/mcp", version: "1.0.0" }],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.type).toBe("http");
    expect(result.value.url).toBe("https://mcp.example.com");
  });

  test("falls back to npm package as stdio", () => {
    const result = pickPackageForInstall({
      ...baseServer,
      packages: [{ registryType: "npm", identifier: "@example/mcp", version: "1.2.3" }],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.type).toBe("stdio");
    expect(result.value.command).toBe("npx");
    expect(result.value.args).toEqual(["-y", "@example/mcp@1.2.3"]);
  });

  test("uses package version 'latest' when registry omits version", () => {
    const result = pickPackageForInstall({
      ...baseServer,
      packages: [{ registryType: "npm", identifier: "@example/mcp" }],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.args).toEqual(["-y", "@example/mcp@latest"]);
  });

  test("falls back to OCI/docker package as stdio", () => {
    const result = pickPackageForInstall({
      ...baseServer,
      packages: [{ registryType: "oci", identifier: "ghcr.io/example/mcp", version: "1.0.0" }],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.type).toBe("stdio");
    expect(result.value.command).toBe("docker");
    expect(result.value.args?.[0]).toBe("run");
    expect(result.value.args).toContain("ghcr.io/example/mcp:1.0.0");
  });

  test("returns INSTALL_NO_PACKAGE when no usable package", () => {
    const result = pickPackageForInstall({
      ...baseServer,
      packages: [{ registryType: "exotic", identifier: "?" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("no installable");
  });

  test("returns INSTALL_NO_PACKAGE when neither packages nor remotes", () => {
    const result = pickPackageForInstall(baseServer);
    expect(result.ok).toBe(false);
  });
});

describe("installMcpServer", () => {
  test("writes config and verifies via injected connection", async () => {
    const { path, cleanup } = tmpFile();
    try {
      const result = await installMcpServer({
        server: {
          ...baseServer,
          packages: [{ registryType: "npm", identifier: "@example/mcp", version: "1.0.0" }],
        },
        configPath: path,
        deps: {
          verifyConnection: async () => ({ ok: true, value: [] }),
        },
      });
      expect(result.ok).toBe(true);
      const file = JSON.parse(await Bun.file(path).text()) as {
        mcpServers: Record<string, ExternalServerConfig>;
      };
      expect(file.mcpServers["io.example/foo"]?.command).toBe("npx");
    } finally {
      cleanup();
    }
  });

  test("rolls back config when verification fails", async () => {
    const { path, cleanup } = tmpFile();
    try {
      const result = await installMcpServer({
        server: {
          ...baseServer,
          packages: [{ registryType: "npm", identifier: "@example/mcp", version: "1.0.0" }],
        },
        configPath: path,
        deps: {
          verifyConnection: async () => ({
            ok: false,
            error: { code: "EXTERNAL", message: "boom", retryable: false },
          }),
        },
      });
      expect(result.ok).toBe(false);
      // Config file should not contain the failed entry.
      const text = await Bun.file(path)
        .text()
        .catch(() => null);
      if (text !== null) {
        const file = JSON.parse(text) as { mcpServers: Record<string, ExternalServerConfig> };
        expect(file.mcpServers["io.example/foo"]).toBeUndefined();
      }
    } finally {
      cleanup();
    }
  });

  test("does not overwrite an existing entry by default", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(
        path,
        JSON.stringify({
          mcpServers: { "io.example/foo": { type: "stdio", command: "existing" } },
        }),
      );
      const result = await installMcpServer({
        server: {
          ...baseServer,
          packages: [{ registryType: "npm", identifier: "@example/mcp", version: "1.0.0" }],
        },
        configPath: path,
        deps: { verifyConnection: async () => ({ ok: true, value: [] }) },
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("CONFLICT");
    } finally {
      cleanup();
    }
  });

  test("skips verification when skipVerify: true", async () => {
    const { path, cleanup } = tmpFile();
    let called = false;
    try {
      const result = await installMcpServer({
        server: {
          ...baseServer,
          packages: [{ registryType: "npm", identifier: "@example/mcp", version: "1.0.0" }],
        },
        configPath: path,
        skipVerify: true,
        deps: {
          verifyConnection: async () => {
            called = true;
            return { ok: true, value: [] };
          },
        },
      });
      expect(result.ok).toBe(true);
      expect(called).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("uninstallMcpServer", () => {
  test("removes the entry", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(
        path,
        JSON.stringify({
          mcpServers: { "io.example/foo": { type: "stdio", command: "x" } },
        }),
      );
      const result = await uninstallMcpServer({ name: "io.example/foo", configPath: path });
      expect(result.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("returns NOT_FOUND when entry is absent", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(path, JSON.stringify({ mcpServers: {} }));
      const result = await uninstallMcpServer({ name: "io.example/missing", configPath: path });
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("calls clearStoredCredentials hook", async () => {
    const { path, cleanup } = tmpFile();
    try {
      await Bun.write(
        path,
        JSON.stringify({ mcpServers: { "io.example/foo": { type: "stdio", command: "x" } } }),
      );
      let cleared = "";
      await uninstallMcpServer({
        name: "io.example/foo",
        configPath: path,
        deps: {
          clearStoredCredentials: async (name: string): Promise<void> => {
            cleared = name;
          },
        },
      });
      expect(cleared).toBe("io.example/foo");
    } finally {
      cleanup();
    }
  });
});
