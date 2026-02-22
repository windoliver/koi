/**
 * Mock agent and engine adapter factories for testing.
 *
 * Provides configurable mocks for the ECS Agent entity and EngineAdapter,
 * usable across all packages that depend on @koi/core.
 */

import type {
  Agent,
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineMetrics,
  EngineOutput,
  EngineState,
  ProcessId,
  ProcessState,
  SubsystemToken,
} from "@koi/core";
import { agentId } from "@koi/core";

// ---------------------------------------------------------------------------
// MockStatefulEngine types
// ---------------------------------------------------------------------------

/**
 * Deterministic, JSON-serializable state for the mock stateful engine.
 *
 * Used by `createMockStatefulEngine` to track calls and provide verifiable
 * state for round-trip persistence tests.
 */
export interface MockEngineData {
  readonly turnCount: number;
  readonly lastInput: string | null;
  readonly customData: unknown;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

const DEFAULT_PID: ProcessId = {
  id: agentId("mock-agent-1"),
  name: "Mock Agent",
  type: "worker",
  depth: 0,
};

const DEFAULT_MANIFEST: AgentManifest = {
  name: "mock-agent",
  version: "0.0.1",
  description: "A mock agent for testing",
  model: { name: "test-model" },
};

const DEFAULT_METRICS: EngineMetrics = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  durationMs: 0,
};

// ---------------------------------------------------------------------------
// createMockAgent
// ---------------------------------------------------------------------------

export interface MockAgentOptions {
  readonly pid?: Partial<ProcessId>;
  readonly manifest?: Partial<AgentManifest>;
  readonly state?: ProcessState;
  readonly components?: ReadonlyMap<string, unknown>;
}

/**
 * Creates a mock Agent ECS entity for testing.
 *
 * Returns an immutable Agent that satisfies the @koi/core Agent interface.
 * All ECS query methods operate on the provided components map.
 */
export function createMockAgent(options?: MockAgentOptions): Agent {
  const pid: ProcessId = { ...DEFAULT_PID, ...options?.pid };
  const manifest: AgentManifest = { ...DEFAULT_MANIFEST, ...options?.manifest };
  const state: ProcessState = options?.state ?? "running";
  const componentMap: ReadonlyMap<string, unknown> =
    options?.components ?? new Map<string, unknown>();

  return {
    pid,
    manifest,
    state,
    // SubsystemToken<T> is a branded string — casts mirror L0's token() factory
    component<T>(token: SubsystemToken<T>): T | undefined {
      return componentMap.get(token as string) as T | undefined;
    },
    has(token: SubsystemToken<unknown>): boolean {
      return componentMap.has(token as string);
    },
    hasAll(...tokens: readonly SubsystemToken<unknown>[]): boolean {
      return tokens.every((t) => componentMap.has(t as string));
    },
    query<T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of componentMap) {
        if (key.startsWith(prefix)) {
          result.set(key as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components(): ReadonlyMap<string, unknown> {
      return componentMap;
    },
  };
}

// ---------------------------------------------------------------------------
// createMockEngineAdapter
// ---------------------------------------------------------------------------

export interface MockEngineAdapterOptions {
  readonly engineId?: string;
  /** Events to yield from stream(). Defaults to a single "done" event. */
  readonly events?: readonly EngineEvent[];
  /** Whether saveState/loadState are available. */
  readonly stateful?: boolean;
  /** Custom dispose behavior. */
  readonly onDispose?: () => Promise<void>;
}

/**
 * Creates a mock EngineAdapter for testing.
 *
 * The stream() method yields the provided events sequence (defaults to a
 * single "done" event). Tracks dispose() calls for assertion purposes.
 */
export function createMockEngineAdapter(options?: MockEngineAdapterOptions): EngineAdapter & {
  readonly disposeCalls: readonly unknown[];
  readonly streamCalls: readonly EngineInput[];
} {
  const disposeCalls: unknown[] = [];
  const streamCalls: EngineInput[] = [];

  const defaultOutput: EngineOutput = {
    content: [],
    stopReason: "completed",
    metrics: DEFAULT_METRICS,
  };

  const events: readonly EngineEvent[] = options?.events ?? [
    { kind: "done", output: defaultOutput },
  ];

  let savedState: EngineState | undefined;

  return {
    engineId: options?.engineId ?? "mock-engine",

    async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
      streamCalls.push(input);
      for (const event of events) {
        yield event;
      }
    },

    ...(options?.stateful === true
      ? {
          async saveState(): Promise<EngineState> {
            return savedState ?? { engineId: options?.engineId ?? "mock-engine", data: null };
          },
          async loadState(state: EngineState): Promise<void> {
            savedState = state;
          },
        }
      : {}),

    async dispose(): Promise<void> {
      disposeCalls.push(Date.now());
      if (options?.onDispose !== undefined) {
        await options.onDispose();
      }
    },

    disposeCalls,
    streamCalls,
  };
}

// ---------------------------------------------------------------------------
// createMockStatefulEngine
// ---------------------------------------------------------------------------

export interface MockStatefulEngineOptions {
  readonly engineId?: string;
  /** Initial custom data stored alongside turn tracking. Defaults to `null`. */
  readonly initialCustomData?: unknown;
}

/**
 * A stateful engine adapter whose state is fully deterministic and
 * JSON-round-trip safe. Designed for testing session-store persistence,
 * checkpoint save/load, and crash recovery flows.
 *
 * Behavior:
 * - `stream()` increments `turnCount` and captures the input text (or "resume"
 *   for resume inputs, "messages" for message inputs).
 * - `saveState()` returns the current `MockEngineData` as `EngineState.data`.
 * - `loadState()` restores from a previously saved `EngineState`.
 * - State survives `JSON.parse(JSON.stringify(state))` without data loss.
 */
export function createMockStatefulEngine(options?: MockStatefulEngineOptions): EngineAdapter & {
  /** Read current state without going through saveState(). */
  readonly currentData: () => MockEngineData;
} {
  const eid = options?.engineId ?? "mock-stateful-engine";

  let data: MockEngineData = {
    turnCount: 0,
    lastInput: null,
    customData: options?.initialCustomData ?? null,
  };

  function inputLabel(input: EngineInput): string {
    switch (input.kind) {
      case "text":
        return input.text;
      case "messages":
        return "messages";
      case "resume":
        return "resume";
    }
  }

  return {
    engineId: eid,

    async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
      data = {
        turnCount: data.turnCount + 1,
        lastInput: inputLabel(input),
        customData: data.customData,
      };

      const output: EngineOutput = {
        content: [{ kind: "text", text: `turn-${String(data.turnCount)}` }],
        stopReason: "completed",
        metrics: DEFAULT_METRICS,
      };
      yield { kind: "done", output };
    },

    async saveState(): Promise<EngineState> {
      return { engineId: eid, data };
    },

    async loadState(state: EngineState): Promise<void> {
      data = state.data as MockEngineData;
    },

    async dispose(): Promise<void> {
      // no-op
    },

    currentData(): MockEngineData {
      return data;
    },
  };
}
