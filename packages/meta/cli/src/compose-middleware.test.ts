/**
 * Characterization tests for middleware composition.
 *
 * Verifies ordering of middleware and providers across
 * the full composition pipeline.
 */

import { describe, expect, test } from "bun:test";
import type { ComponentProvider, KoiMiddleware } from "@koi/core";
import { collectSubsystemMiddleware, composeRuntimeMiddleware } from "./compose-middleware.js";
import type { AutonomousResult } from "./resolve-autonomous.js";
import type { NexusResolvedState } from "./resolve-nexus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockMiddleware(name: string): KoiMiddleware {
  return { name } as unknown as KoiMiddleware;
}

function mockProvider(name: string): ComponentProvider {
  return { name } as unknown as ComponentProvider;
}

function createNexusState(overrides?: Partial<NexusResolvedState>): NexusResolvedState {
  return {
    middlewares: [mockMiddleware("nexus-mw")],
    providers: [mockProvider("nexus-prov")],
    dispose: undefined,
    baseUrl: "http://localhost:2026",
    ...overrides,
  };
}

function createForgeBootstrapMock(): {
  readonly middlewares: readonly KoiMiddleware[];
  readonly provider: ComponentProvider;
  readonly forgeToolsProvider: ComponentProvider;
  readonly runtime: never;
  readonly store: never;
  readonly system: never;
  readonly dispose: () => void;
} {
  return {
    middlewares: [mockMiddleware("forge-mw")],
    provider: mockProvider("forge-prov"),
    forgeToolsProvider: mockProvider("forge-tools-prov"),
    runtime: undefined as never,
    store: undefined as never,
    system: undefined as never,
    dispose: () => {},
  };
}

function createAutonomousResult(): AutonomousResult {
  return {
    middleware: [mockMiddleware("autonomous-mw")],
    providers: [mockProvider("autonomous-prov")],
    harness: {} as AutonomousResult["harness"],
    dispose: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("composeRuntimeMiddleware", () => {
  test("middleware ordering: resolved → preset → extra → nexus → forge → autonomous → chatBridge", () => {
    const chatBridge = {
      middleware: mockMiddleware("chatBridge-mw"),
    };

    const composed = composeRuntimeMiddleware({
      resolved: [mockMiddleware("resolved-mw")],
      nexus: createNexusState(),
      forge: createForgeBootstrapMock(),
      autonomous: createAutonomousResult(),
      chatBridge: chatBridge as never,
      extra: [mockMiddleware("extra-mw")],
      presetMiddleware: [mockMiddleware("preset-mw")],
    });

    const names = composed.middleware.map((m) => (m as unknown as { readonly name: string }).name);
    expect(names).toEqual([
      "resolved-mw",
      "preset-mw",
      "extra-mw",
      "nexus-mw",
      "forge-mw",
      "autonomous-mw",
      "chatBridge-mw",
    ]);
  });

  test("provider ordering: dataSource → dsTools → preset → extra → nexus → forge → autonomous", () => {
    const dsTool = {
      descriptor: { name: "query_ds" },
    };

    const composed = composeRuntimeMiddleware({
      resolved: [],
      nexus: createNexusState(),
      forge: createForgeBootstrapMock(),
      autonomous: createAutonomousResult(),
      chatBridge: undefined,
      dataSourceProvider: mockProvider("ds-prov"),
      dataSourceTools: [dsTool as never],
      presetProviders: [mockProvider("preset-prov")],
      extraProviders: [mockProvider("extra-prov")],
    });

    const names = composed.providers.map((p) => (p as unknown as { readonly name: string }).name);
    expect(names).toEqual([
      "ds-prov",
      "data-source:query_ds",
      "preset-prov",
      "extra-prov",
      "nexus-prov",
      "forge-prov",
      "forge-tools-prov",
      "autonomous-prov",
    ]);
  });

  test("empty/undefined optional inputs produce empty arrays", () => {
    const composed = composeRuntimeMiddleware({
      resolved: [],
      nexus: {
        middlewares: [],
        providers: [],
        dispose: undefined,
        baseUrl: undefined,
      },
      forge: undefined,
      autonomous: undefined,
      chatBridge: undefined,
    });

    expect(composed.middleware).toEqual([]);
    expect(composed.providers).toEqual([]);
  });

  test("omitting preset slots does not affect ordering", () => {
    const composed = composeRuntimeMiddleware({
      resolved: [mockMiddleware("resolved-mw")],
      nexus: createNexusState(),
      forge: undefined,
      autonomous: undefined,
      chatBridge: undefined,
    });

    const names = composed.middleware.map((m) => (m as unknown as { readonly name: string }).name);
    expect(names).toEqual(["resolved-mw", "nexus-mw"]);
  });
});

describe("collectSubsystemMiddleware", () => {
  test("collects nexus + forge + autonomous middleware and providers", () => {
    const result = collectSubsystemMiddleware({
      nexus: createNexusState(),
      forge: createForgeBootstrapMock(),
      autonomous: createAutonomousResult(),
    });

    const mwNames = result.middleware.map((m) => (m as unknown as { readonly name: string }).name);
    expect(mwNames).toEqual(["nexus-mw", "forge-mw", "autonomous-mw"]);

    const provNames = result.providers.map((p) => (p as unknown as { readonly name: string }).name);
    expect(provNames).toEqual(["nexus-prov", "forge-prov", "forge-tools-prov", "autonomous-prov"]);
  });

  test("handles undefined forge and autonomous", () => {
    const result = collectSubsystemMiddleware({
      nexus: createNexusState(),
      forge: undefined,
      autonomous: undefined,
    });

    const mwNames = result.middleware.map((m) => (m as unknown as { readonly name: string }).name);
    expect(mwNames).toEqual(["nexus-mw"]);

    const provNames = result.providers.map((p) => (p as unknown as { readonly name: string }).name);
    expect(provNames).toEqual(["nexus-prov"]);
  });
});
