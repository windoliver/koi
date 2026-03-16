import { describe, expect, test } from "bun:test";
import { createStore } from "../state/store.js";
import { createInitialState, type TuiState } from "../state/types.js";
import { type ConsentDeps, closeConsent, consentApprove, consentDeny } from "./tui-consent.js";

function makeConsentDeps(state?: Partial<TuiState>): {
  readonly deps: ConsentDeps;
  readonly messages: string[];
} {
  const store = createStore({
    ...createInitialState("http://localhost:3100"),
    ...state,
  });
  const messages: string[] = [];
  const deps: ConsentDeps = {
    store,
    dsDeps: {
      store,
      client: {} as import("@koi/dashboard-client").AdminClient,
      addLifecycleMessage: (msg: string) => {
        messages.push(msg);
      },
    },
    addLifecycleMessage: (msg: string) => {
      messages.push(msg);
    },
  };
  return { deps, messages };
}

describe("consentApprove", () => {
  test("clears pending consent and goes to agents", () => {
    const { deps } = makeConsentDeps({
      pendingConsent: [{ name: "my-db", status: "pending", protocol: "postgres", source: "env" }],
      view: "consent",
    });
    consentApprove(deps);
    expect(deps.store.getState().pendingConsent).toBeUndefined();
    expect(deps.store.getState().view).toBe("agents");
  });

  test("no-ops when no pending consent", () => {
    const { deps } = makeConsentDeps({ pendingConsent: undefined });
    consentApprove(deps);
    expect(deps.store.getState().view).toBe("agents");
  });
});

describe("consentDeny", () => {
  test("clears pending consent and shows message", () => {
    const { deps, messages } = makeConsentDeps({
      pendingConsent: [{ name: "my-db", status: "pending", protocol: "postgres", source: "env" }],
      view: "consent",
    });
    consentDeny(deps);
    expect(deps.store.getState().pendingConsent).toBeUndefined();
    expect(messages).toContain("Data source denied");
  });
});

describe("closeConsent", () => {
  test("returns to agents when no session", () => {
    const { deps } = makeConsentDeps({ view: "consent" });
    closeConsent(deps);
    expect(deps.store.getState().view).toBe("agents");
  });

  test("returns to console when session active", () => {
    const { deps } = makeConsentDeps({
      view: "consent",
      activeSession: {
        agentId: "a-1",
        sessionId: "s-1",
        messages: [],
        pendingText: "",
        isStreaming: false,
      },
    });
    closeConsent(deps);
    expect(deps.store.getState().view).toBe("console");
  });
});
