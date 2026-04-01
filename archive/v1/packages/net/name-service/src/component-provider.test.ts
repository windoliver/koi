import { describe, expect, test } from "bun:test";
import type { AgentId, NameServiceReader } from "@koi/core";
import { NAME_SERVICE } from "@koi/core";
import { createNameServiceProvider } from "./component-provider.js";
import { createInMemoryNameService } from "./in-memory-backend.js";

describe("createNameServiceProvider", () => {
  test("returns a ComponentProvider with correct name and priority", () => {
    const backend = createInMemoryNameService({ defaultTtlMs: 0 });
    const provider = createNameServiceProvider(backend);

    expect(provider.name).toBe("name-service");
    expect(provider.priority).toBe(100); // BUNDLED
    backend.dispose?.();
  });

  test("attach returns AttachResult with NAME_SERVICE key", async () => {
    const backend = createInMemoryNameService({ defaultTtlMs: 0 });
    const provider = createNameServiceProvider(backend);

    // We need a minimal Agent mock for attach — but the provider ignores it
    const result = await provider.attach({} as never);

    // Check result has components key (AttachResult)
    expect("components" in result).toBe(true);
    if ("components" in result) {
      expect(result.components.has(NAME_SERVICE as string)).toBe(true);
    }

    backend.dispose?.();
  });

  test("reader component exposes resolve, search, suggest but not register/unregister", async () => {
    const backend = createInMemoryNameService({ defaultTtlMs: 0 });
    const provider = createNameServiceProvider(backend);

    const result = await provider.attach({} as never);
    const reader = (
      "components" in result
        ? result.components.get(NAME_SERVICE as string)
        : result.get(NAME_SERVICE as string)
    ) as NameServiceReader;

    // Reader methods exist
    expect(typeof reader.resolve).toBe("function");
    expect(typeof reader.search).toBe("function");
    expect(typeof reader.suggest).toBe("function");

    // Writer methods do NOT exist
    expect("register" in reader).toBe(false);
    expect("unregister" in reader).toBe(false);
    expect("renew" in reader).toBe(false);
    expect("dispose" in reader).toBe(false);

    backend.dispose?.();
  });

  test("reader resolves names through the backend", async () => {
    const backend = createInMemoryNameService({ defaultTtlMs: 0 });

    // Register via backend (writer)
    await backend.register({
      name: "reviewer",
      binding: { kind: "agent", agentId: "a1" as AgentId },
      scope: "agent",
      registeredBy: "test",
    });

    const provider = createNameServiceProvider(backend);
    const result = await provider.attach({} as never);
    const reader = (
      "components" in result
        ? result.components.get(NAME_SERVICE as string)
        : result.get(NAME_SERVICE as string)
    ) as NameServiceReader;

    const resolved = await reader.resolve("reviewer");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.record.name).toBe("reviewer");
    }

    backend.dispose?.();
  });
});
