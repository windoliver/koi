import { describe, expect, mock, test } from "bun:test";
import type { AgentManifest, KoiError, SpawnFn, SpawnRequest, SpawnResult } from "@koi/core";

import {
  createRoutingSpawnFn,
  mapManifestToDescriptor,
  mapSandboxConfigToProfile,
} from "./routing-spawn.js";
import type { AgentSpawner } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SIGNAL = AbortSignal.timeout(5_000);

function createManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "test-agent",
    version: "1.0.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

function createSpawnRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    description: "do the thing",
    agentName: "test-agent",
    signal: DEFAULT_SIGNAL,
    ...overrides,
  };
}

function createMockDefaultSpawn(): SpawnFn & ReturnType<typeof mock> {
  return mock(
    async (_request: SpawnRequest): Promise<SpawnResult> => ({
      ok: true,
      output: "default-output",
    }),
  );
}

function createMockAgentSpawner(
  result:
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly error: KoiError },
): AgentSpawner {
  return {
    spawn: mock(async () => result),
    dispose: mock(async () => undefined),
  };
}

// ---------------------------------------------------------------------------
// mapManifestToDescriptor
// ---------------------------------------------------------------------------

describe("mapManifestToDescriptor", () => {
  test("returns undefined when manifest is undefined", () => {
    expect(mapManifestToDescriptor(undefined, "agent")).toBeUndefined();
  });

  test("returns undefined when metadata has no command", () => {
    const manifest = createManifest({ metadata: { other: "value" } });
    expect(mapManifestToDescriptor(manifest, "agent")).toBeUndefined();
  });

  test("returns undefined when metadata is undefined", () => {
    const manifest = createManifest();
    expect(mapManifestToDescriptor(manifest, "agent")).toBeUndefined();
  });

  test("returns undefined when command is empty string", () => {
    const manifest = createManifest({ metadata: { command: "" } });
    expect(mapManifestToDescriptor(manifest, "agent")).toBeUndefined();
  });

  test("returns descriptor with command from metadata", () => {
    const manifest = createManifest({
      metadata: { command: "claude" },
      capabilities: ["code-generation"],
    });

    const result = mapManifestToDescriptor(manifest, "my-agent");
    if (result === undefined) {
      expect(result).toBeDefined();
      return;
    }
    expect(result.name).toBe("my-agent");
    expect(result.command).toBe("claude");
    expect(result.transport).toBe("cli");
    expect(result.capabilities).toEqual(["code-generation"]);
    expect(result.source).toBe("manifest");
    expect(result.protocol).toBeUndefined();
  });

  test("extracts transport from metadata", () => {
    const manifest = createManifest({
      metadata: { command: "my-agent", transport: "mcp" },
    });

    const result = mapManifestToDescriptor(manifest, "agent");
    expect(result).toBeDefined();
    expect(result?.transport).toBe("mcp");
  });

  test("extracts protocol from metadata", () => {
    const manifest = createManifest({
      metadata: { command: "claude", protocol: "acp" },
    });

    const result = mapManifestToDescriptor(manifest, "agent");
    expect(result).toBeDefined();
    expect(result?.protocol).toBe("acp");
  });

  test("ignores invalid transport — falls back to cli", () => {
    const manifest = createManifest({
      metadata: { command: "cmd", transport: "invalid" },
    });

    const result = mapManifestToDescriptor(manifest, "agent");
    expect(result).toBeDefined();
    expect(result?.transport).toBe("cli");
  });

  test("ignores invalid protocol — omits it", () => {
    const manifest = createManifest({
      metadata: { command: "cmd", protocol: "invalid" },
    });

    const result = mapManifestToDescriptor(manifest, "agent");
    expect(result).toBeDefined();
    expect(result?.protocol).toBeUndefined();
  });

  test("uses empty capabilities when manifest has none", () => {
    const manifest = createManifest({ metadata: { command: "cmd" } });

    const result = mapManifestToDescriptor(manifest, "agent");
    expect(result).toBeDefined();
    expect(result?.capabilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapSandboxConfigToProfile
// ---------------------------------------------------------------------------

describe("mapSandboxConfigToProfile", () => {
  test("defaults network to deny", () => {
    const profile = mapSandboxConfigToProfile({});
    expect(profile.network).toEqual({ allow: false });
    expect(profile.filesystem).toEqual({});
    expect(profile.resources).toEqual({});
  });

  test("passes through filesystem policy", () => {
    const profile = mapSandboxConfigToProfile({
      filesystem: { allowRead: ["/home"], allowWrite: ["/tmp"] },
    });
    expect(profile.filesystem).toEqual({ allowRead: ["/home"], allowWrite: ["/tmp"] });
  });

  test("passes through network policy", () => {
    const profile = mapSandboxConfigToProfile({
      network: { allow: true, allowedHosts: ["api.example.com"] },
    });
    expect(profile.network).toEqual({ allow: true, allowedHosts: ["api.example.com"] });
  });

  test("passes through resource limits", () => {
    const profile = mapSandboxConfigToProfile({
      resources: { timeoutMs: 30_000, maxMemoryMb: 512 },
    });
    expect(profile.resources).toEqual({ timeoutMs: 30_000, maxMemoryMb: 512 });
  });
});

// ---------------------------------------------------------------------------
// createRoutingSpawnFn
// ---------------------------------------------------------------------------

describe("createRoutingSpawnFn", () => {
  test("routes to agent-spawner when manifest.sandbox and command are present", async () => {
    const defaultSpawn = createMockDefaultSpawn();
    const agentSpawner = createMockAgentSpawner({ ok: true, value: "sandboxed-output" });

    const routingSpawn = createRoutingSpawnFn({ defaultSpawn, agentSpawner });

    const manifest = createManifest({
      sandbox: { adapter: "e2b" },
      metadata: { command: "claude" },
      capabilities: ["code-generation"],
    });

    const result = await routingSpawn(createSpawnRequest({ manifest }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe("sandboxed-output");
    }

    expect(agentSpawner.spawn).toHaveBeenCalledTimes(1);
    expect(defaultSpawn).not.toHaveBeenCalled();
  });

  test("routes to default spawn when manifest.sandbox is absent", async () => {
    const defaultSpawn = createMockDefaultSpawn();
    const agentSpawner = createMockAgentSpawner({ ok: true, value: "unused" });

    const routingSpawn = createRoutingSpawnFn({ defaultSpawn, agentSpawner });

    const manifest = createManifest({ metadata: { command: "claude" } });

    const result = await routingSpawn(createSpawnRequest({ manifest }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe("default-output");
    }

    expect(defaultSpawn).toHaveBeenCalledTimes(1);
    expect(agentSpawner.spawn).not.toHaveBeenCalled();
  });

  test("routes to default spawn when manifest is undefined", async () => {
    const defaultSpawn = createMockDefaultSpawn();
    const agentSpawner = createMockAgentSpawner({ ok: true, value: "unused" });

    const routingSpawn = createRoutingSpawnFn({ defaultSpawn, agentSpawner });

    const result = await routingSpawn(createSpawnRequest({ manifest: undefined }));

    expect(result.ok).toBe(true);
    expect(defaultSpawn).toHaveBeenCalledTimes(1);
    expect(agentSpawner.spawn).not.toHaveBeenCalled();
  });

  test("falls through to default spawn when sandbox defined but no command", async () => {
    const defaultSpawn = createMockDefaultSpawn();
    const agentSpawner = createMockAgentSpawner({ ok: true, value: "unused" });

    const routingSpawn = createRoutingSpawnFn({ defaultSpawn, agentSpawner });

    // sandbox defined but no metadata.command
    const manifest = createManifest({ sandbox: { adapter: "e2b" } });

    const result = await routingSpawn(createSpawnRequest({ manifest }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe("default-output");
    }

    expect(defaultSpawn).toHaveBeenCalledTimes(1);
    expect(agentSpawner.spawn).not.toHaveBeenCalled();
  });

  test("propagates agent-spawner errors as SpawnResult errors", async () => {
    const koiError: KoiError = {
      code: "EXTERNAL",
      message: "sandbox crashed",
      retryable: true,
    };
    const defaultSpawn = createMockDefaultSpawn();
    const agentSpawner = createMockAgentSpawner({ ok: false, error: koiError });

    const routingSpawn = createRoutingSpawnFn({ defaultSpawn, agentSpawner });

    const manifest = createManifest({
      sandbox: {},
      metadata: { command: "claude" },
    });

    const result = await routingSpawn(createSpawnRequest({ manifest }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toBe("sandbox crashed");
    }

    expect(agentSpawner.spawn).toHaveBeenCalledTimes(1);
    expect(defaultSpawn).not.toHaveBeenCalled();
  });

  test("passes correct profile and descriptor to agent-spawner", async () => {
    const defaultSpawn = createMockDefaultSpawn();
    const agentSpawner = createMockAgentSpawner({ ok: true, value: "ok" });

    const routingSpawn = createRoutingSpawnFn({ defaultSpawn, agentSpawner });

    const manifest = createManifest({
      sandbox: {
        filesystem: { allowRead: ["/code"] },
        network: { allow: true },
        resources: { timeoutMs: 60_000 },
      },
      metadata: { command: "aider", protocol: "stdio" },
      capabilities: ["code-generation", "file-editing"],
    });

    await routingSpawn(
      createSpawnRequest({
        manifest,
        agentName: "my-aider",
        description: "fix the bug",
      }),
    );

    const spawnCall = (agentSpawner.spawn as ReturnType<typeof mock>).mock.calls[0];
    const [descriptor, prompt, options] = spawnCall ?? [];

    // Descriptor
    expect(descriptor.name).toBe("my-aider");
    expect(descriptor.command).toBe("aider");
    expect(descriptor.protocol).toBe("stdio");
    expect(descriptor.capabilities).toEqual(["code-generation", "file-editing"]);

    // Prompt
    expect(prompt).toBe("fix the bug");

    // Profile
    expect(options.profile.filesystem).toEqual({ allowRead: ["/code"] });
    expect(options.profile.network).toEqual({ allow: true });
    expect(options.profile.resources).toEqual({ timeoutMs: 60_000 });
  });

  test("passes request unchanged to default spawn", async () => {
    const defaultSpawn = createMockDefaultSpawn();
    const agentSpawner = createMockAgentSpawner({ ok: true, value: "unused" });

    const routingSpawn = createRoutingSpawnFn({ defaultSpawn, agentSpawner });

    const request = createSpawnRequest({ agentName: "worker-1", description: "summarize" });
    await routingSpawn(request);

    const call = (defaultSpawn as ReturnType<typeof mock>).mock.calls[0];
    expect(call?.[0]).toBe(request);
  });
});
