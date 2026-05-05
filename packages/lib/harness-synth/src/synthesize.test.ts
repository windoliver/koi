import { describe, expect, mock, test } from "bun:test";
import type { ForgeCandidate } from "@koi/forge-types";
import { synthesize } from "./synthesize.js";
import type { GenerateCallback, SynthesisInput, VerifyCallback, VerifyResult } from "./types.js";

const CANDIDATE: ForgeCandidate = {
  id: "cand-1",
  kind: "tool",
  name: "echo_tool",
  description: "Echoes its input back",
  priority: 0.5,
  proposedScope: "agent",
  createdAt: 1_700_000_000_000,
};

const INPUT: SynthesisInput = {
  candidate: CANDIDATE,
  targetToolName: "echo_tool",
  targetToolSchema: { type: "object" },
};

/** Most tests pass through retries; opt in by default. */
const ABORT_HONORED = { adapterHonorsAbort: true } as const;

function validRaw(name = "echo_tool", code = "export const run = (x) => x;"): string {
  return JSON.stringify({
    descriptor: { name, description: "Echoes input", inputSchema: { type: "object" } },
    code,
  });
}

const ALWAYS_OK: VerifyCallback = () => ({ ok: true });

describe("synthesize", () => {
  test("returns success on first attempt when generate + verify both succeed", async () => {
    const generate = mock<GenerateCallback>(async () => validRaw());
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      clock: () => 42,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(1);
    expect(result.value.forgedBy).toBe("harness-synth");
    expect(result.value.synthesizedAt).toBe(42);
    expect(result.value.descriptor.name).toBe("echo_tool");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("retries on verify failure with refinement prompt", async () => {
    const generate = mock<GenerateCallback>(async () => validRaw());
    let calls = 0;
    const verify: VerifyCallback = () => {
      calls += 1;
      return calls === 1 ? { ok: false, reason: "syntax check failed" } : { ok: true };
    };
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 3,
      adapterHonorsAbort: true,
      sanitizeVerifierReason: (s) => s, // opt in to forwarding for this test
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
    const secondPrompt = generate.mock.calls[1]?.[0] ?? "";
    expect(secondPrompt).toContain("syntax check failed");
  });

  test("retries on parse failure", async () => {
    let n = 0;
    const generate: GenerateCallback = async () => {
      n += 1;
      return n === 1 ? "garbage with no tags" : validRaw();
    };
    const result = await synthesize(INPUT, { generate, verify: ALWAYS_OK, ...ABORT_HONORED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
  });

  test("fails after maxAttempts when verify never succeeds", async () => {
    const generate: GenerateCallback = async () => validRaw();
    const verify: VerifyCallback = () => ({ ok: false, reason: "still wrong" });
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 3,
      adapterHonorsAbort: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(3);
    expect(result.reason).toBe("still wrong");
  });

  test("post-timeout late success cannot override the timeout failure", async () => {
    // generate is slow but resolves successfully WITHIN the unwind grace
    // window after timeout. The chosen timeout failure must still win.
    const generate: GenerateCallback = (_p, signal) =>
      new Promise<string>((resolve) => {
        const onAbort = (): void => {
          // Simulate "tear down then succeed anyway" — the contract says
          // the abort decision is terminal regardless of late success.
          setTimeout(() => resolve(validRaw()), 50);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 1,
      attemptTimeoutMs: 20,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/timed out/);
  });

  test("post-abort late verify success cannot override the caller-abort failure", async () => {
    const controller = new AbortController();
    const verify: VerifyCallback = (_c, _d, signal) =>
      new Promise<VerifyResult>((resolve) => {
        const onAbort = (): void => {
          setTimeout(() => resolve({ ok: true }), 50);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    setTimeout(() => controller.abort(), 5);
    const result = await synthesize(INPUT, {
      generate: async () => validRaw(),
      verify,
      maxAttempts: 1,
      signal: controller.signal,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/aborted by caller/);
  });

  test("waits for aborted callback to unwind before starting next attempt", async () => {
    // After timeout, the next attempt must NOT start while the prior
    // callback is still running its post-abort cleanup. Track overlap
    // by counting concurrent in-flight calls.
    let concurrent = 0;
    let maxConcurrent = 0;
    let n = 0;
    const generate: GenerateCallback = (_p, signal) => {
      n += 1;
      const myAttempt = n;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise<string>((resolve) => {
        const onAbort = (): void => {
          // Simulate slow async cleanup (network teardown, sandbox kill).
          setTimeout(() => {
            concurrent -= 1;
            // Second attempt resolves a real value so the loop terminates.
            resolve(myAttempt === 1 ? "" : validRaw());
          }, 50);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 2,
      attemptTimeoutMs: 30,
      ...ABORT_HONORED,
    });
    void result; // either ok or fail acceptable; we care about non-overlap
    expect(maxConcurrent).toBe(1);
  });

  test("rejects Infinity maxAttempts (no unbounded loop)", async () => {
    const result = await synthesize(INPUT, {
      generate: async () => "garbage",
      verify: ALWAYS_OK,
      maxAttempts: Number.POSITIVE_INFINITY,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/maxAttempts/);
    expect(result.attempts).toBe(0);
  });

  test("rejects NaN maxAttempts", async () => {
    const result = await synthesize(INPUT, {
      generate: async () => validRaw(),
      verify: ALWAYS_OK,
      maxAttempts: Number.NaN,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/maxAttempts/);
  });

  test("rejects fractional maxAttempts", async () => {
    const result = await synthesize(INPUT, {
      generate: async () => validRaw(),
      verify: ALWAYS_OK,
      maxAttempts: 2.5,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/maxAttempts/);
  });

  test("rejects maxAttempts < 1", async () => {
    const result = await synthesize(INPUT, {
      generate: async () => "",
      verify: ALWAYS_OK,
      maxAttempts: 0,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(0);
    expect(result.reason).toMatch(/maxAttempts/);
  });

  test("recovers from verify-throwing on first attempt", async () => {
    const prompts: string[] = [];
    const generate: GenerateCallback = async (p) => {
      prompts.push(p);
      return validRaw();
    };
    let n = 0;
    const verify: VerifyCallback = () => {
      n += 1;
      if (n === 1) throw new Error("verifier crashed");
      return { ok: true };
    };
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 3,
      adapterHonorsAbort: true,
      sanitizeVerifierReason: (s) => s,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
    expect(prompts[1] ?? "").toContain("Verifier failed");
  });

  test("returns typed failure when verify throws on every attempt", async () => {
    const generate: GenerateCallback = async () => validRaw();
    const verify: VerifyCallback = () => {
      throw new Error("flaky");
    };
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 2,
      adapterHonorsAbort: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Verifier failed/);
    expect(result.attempts).toBe(2);
  });

  test("recovers from generate-throwing on first attempt", async () => {
    let n = 0;
    const generate: GenerateCallback = async () => {
      n += 1;
      if (n === 1) throw new Error("LLM offline");
      return validRaw();
    };
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 3,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
  });

  test("uses synchronous verify return value", async () => {
    const generate: GenerateCallback = async () => validRaw();
    const verify: VerifyCallback = () => ({ ok: true });
    const result = await synthesize(INPUT, { generate, verify, ...ABORT_HONORED });
    expect(result.ok).toBe(true);
  });

  test("default maxAttempts is 3", async () => {
    const generate: GenerateCallback = async () => validRaw();
    const verify: VerifyCallback = () => ({ ok: false, reason: "nope" });
    const result = await synthesize(INPUT, { generate, verify, ...ABORT_HONORED });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(3);
  });

  test("returns typed failure for cyclic targetToolSchema", async () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    const result = await synthesize(
      { ...INPUT, targetToolSchema: cyclic },
      { generate: async () => validRaw(), verify: ALWAYS_OK, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/targetToolSchema/);
    expect(result.attempts).toBe(0);
  });

  test("returns typed failure for throwing-getter targetToolSchema", async () => {
    const schema: Record<string, unknown> = { type: "object" };
    Object.defineProperty(schema, "evil", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    const result = await synthesize(
      { ...INPUT, targetToolSchema: schema },
      { generate: async () => validRaw(), verify: ALWAYS_OK, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/targetToolSchema/);
  });

  test("rejects targetToolSchema with undefined / non-finite values (no lossy normalization)", async () => {
    const schema = { type: "object", missing: undefined, weight: Number.POSITIVE_INFINITY };
    const result = await synthesize(
      { ...INPUT, targetToolSchema: schema as Record<string, unknown> },
      { generate: async () => validRaw(), verify: ALWAYS_OK, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/targetToolSchema/);
  });

  test("honors external signal in best-effort mode (synthesize() resolves promptly)", async () => {
    // In best-effort mode the callback may not honor abort, but synthesize()
    // itself MUST still resolve when the caller cancels — otherwise a stuck
    // adapter pins the request indefinitely. The caller accepts that the
    // background callback may keep running; what they need is a prompt
    // typed failure so they can move on.
    const controller = new AbortController();
    const generate: GenerateCallback = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => controller.abort(), 5);
        // Resolves long after the abort — synthesize() must not wait for it.
        setTimeout(() => resolve(validRaw()), 1000);
      });
    const start = Date.now();
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 1,
      signal: controller.signal,
      adapterHonorsAbort: false,
    });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/aborted by caller/);
    // 1000ms abort-settlement grace window + a small buffer.
    expect(elapsed).toBeLessThan(1500);
  });

  test("rejects verifier summary with non-JSON-plain extras (Date)", async () => {
    // A leaky verifier that includes a Date / class instance must be
    // rejected, not silently dropped — downstream forge provenance
    // requires JSON-plain values, and silent stripping hides drift.
    const generate: GenerateCallback = async () => validRaw();
    const verify: VerifyCallback = () => ({
      ok: true,
      summary: {
        passed: true,
        sandbox: false,
        totalDurationMs: 5,
        stageResults: [{ stage: "syntax", passed: true, durationMs: 2 }],
        // biome-ignore lint/suspicious/noExplicitAny: simulating leaky verifier output.
        leak: new Date() as any,
      },
    });
    const result = await synthesize(INPUT, { generate, verify, ...ABORT_HONORED });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/summary/);
  });

  test("preserves verifier-supplied JSON-plain extras (digests, ids)", async () => {
    const generate: GenerateCallback = async () => validRaw();
    const verify: VerifyCallback = () => ({
      ok: true,
      summary: {
        passed: true,
        sandbox: true,
        totalDurationMs: 12,
        stageResults: [{ stage: "syntax", passed: true, durationMs: 2 }],
        // Extra JSON-plain fields (audit metadata) must flow through.
        attestationId: "att-123",
        digest: "sha256:abc",
      } as never,
    });
    const result = await synthesize(INPUT, { generate, verify, ...ABORT_HONORED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = result.value.verification as Record<string, unknown> | undefined;
    if (v === undefined) throw new Error("verification missing");
    expect(v.attestationId).toBe("att-123");
    expect(v.digest).toBe("sha256:abc");
  });

  test("forces single-shot when adapterHonorsAbort is false (default)", async () => {
    let calls = 0;
    const generate: GenerateCallback = async () => {
      calls += 1;
      return validRaw();
    };
    const verify: VerifyCallback = () => ({ ok: false, reason: "no" });
    // Caller explicitly asks for 5 attempts but did not assert hard abort —
    // synthesize must clamp to 1 to avoid overlapping side effects on retry.
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 5,
      adapterHonorsAbort: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("rejects descriptor.inputSchema mismatch when targetToolSchema set", async () => {
    const generate: GenerateCallback = async () =>
      JSON.stringify({
        descriptor: {
          name: "echo_tool",
          description: "x",
          inputSchema: { type: "object", properties: { foo: { type: "string" } } },
        },
        code: "x();",
      });
    const result = await synthesize(
      {
        ...INPUT,
        targetToolSchema: { type: "object", properties: { bar: { type: "number" } } },
      },
      { generate, verify: ALWAYS_OK, maxAttempts: 1, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/inputSchema/);
  });

  test("accepts schema match (key-order independent)", async () => {
    const generate: GenerateCallback = async () =>
      JSON.stringify({
        descriptor: {
          name: "echo_tool",
          description: "x",
          // intentionally reordered properties
          inputSchema: { properties: { foo: { type: "string" } }, type: "object" },
        },
        code: "x();",
      });
    const result = await synthesize(
      {
        ...INPUT,
        targetToolSchema: { type: "object", properties: { foo: { type: "string" } } },
      },
      { generate, verify: ALWAYS_OK, maxAttempts: 1, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(true);
  });

  test("coerces undefined verifier return into typed failure", async () => {
    const generate: GenerateCallback = async () => validRaw();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately injecting a misbehaving verifier.
    const verify = (() => undefined) as any as VerifyCallback;
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 1,
      adapterHonorsAbort: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/non-object/);
  });

  test("coerces empty-object verifier return into typed failure", async () => {
    const generate: GenerateCallback = async () => validRaw();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately injecting a misbehaving verifier.
    const verify = (() => ({})) as any as VerifyCallback;
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 1,
      adapterHonorsAbort: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/malformed/);
  });

  test("returns typed failure when generate yields a non-string", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately injecting a misbehaving adapter.
    const generate = (async () => ({ not: "a string" })) as any as GenerateCallback;
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 2,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/non-string/);
  });

  test("times out a hung generator instead of stalling forever", async () => {
    const generate: GenerateCallback = () => new Promise(() => {}); // never resolves
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 1,
      attemptTimeoutMs: 25,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/timed out/);
  });

  test("times out a hung verifier instead of stalling forever", async () => {
    const generate: GenerateCallback = async () => validRaw();
    const verify: VerifyCallback = () => new Promise(() => {});
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 1,
      attemptTimeoutMs: 25,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/timed out/);
  });

  test("enforces attemptTimeoutMs in best-effort mode (forces maxAttempts=1, no retry)", async () => {
    // Timeouts are honored even in best-effort mode so synthesize() cannot
    // hang on a stuck adapter — but maxAttempts is still forced to 1 so the
    // loop never starts a second attempt while the first may still be in
    // flight.
    let calls = 0;
    const generate: GenerateCallback = () => {
      calls += 1;
      return new Promise<string>(() => undefined); // never settles
    };
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 5, // ignored in best-effort
      attemptTimeoutMs: 10,
      adapterHonorsAbort: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/timed out/);
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("respects an external AbortSignal mid-flight", async () => {
    const controller = new AbortController();
    const generate: GenerateCallback = () =>
      new Promise((_resolve) => {
        setTimeout(() => controller.abort(), 5);
      });
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 5,
      attemptTimeoutMs: 1_000,
      signal: controller.signal,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/aborted/);
  });

  test("respects a pre-aborted signal without running any attempts", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const generate: GenerateCallback = async () => {
      calls += 1;
      return validRaw();
    };
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 3,
      signal: controller.signal,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/aborted/);
    expect(calls).toBe(0);
  });

  test("forwards an AbortSignal to generate + verify", async () => {
    let genSignal: AbortSignal | undefined;
    let verSignal: AbortSignal | undefined;
    const generate: GenerateCallback = async (_p, signal) => {
      genSignal = signal;
      return validRaw();
    };
    const verify: VerifyCallback = (_c, _d, signal) => {
      verSignal = signal;
      return { ok: true };
    };
    const result = await synthesize(INPUT, { generate, verify, ...ABORT_HONORED });
    expect(result.ok).toBe(true);
    expect(genSignal).toBeInstanceOf(AbortSignal);
    expect(verSignal).toBeInstanceOf(AbortSignal);
  });

  test("aborts the previous attempt before the next one starts (no overlap)", async () => {
    const observedAborts: boolean[] = [];
    let n = 0;
    const generate: GenerateCallback = (_p, signal) =>
      new Promise<string>((resolve) => {
        n += 1;
        const myAttempt = n;
        signal.addEventListener("abort", () => {
          observedAborts.push(myAttempt === 1);
        });
        if (myAttempt === 1) {
          // never resolve — let timeout fire
          return;
        }
        resolve(validRaw());
      });
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 2,
      attemptTimeoutMs: 25,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
    // First attempt must have observed an abort before the second one resolved.
    expect(observedAborts).toContain(true);
  });

  test("rejects ok:true with malformed verification summary", async () => {
    const generate: GenerateCallback = async () => validRaw();
    const verify = (() => ({
      ok: true,
      summary: { passed: true /* missing required fields */ },
    })) as unknown as VerifyCallback;
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 1,
      adapterHonorsAbort: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/malformed summary/);
  });

  test("rejects ok:true with empty stage name (downstream provenance invariant)", async () => {
    const generate: GenerateCallback = async () => validRaw();
    const verify = (() => ({
      ok: true,
      summary: {
        passed: true,
        sandbox: false,
        totalDurationMs: 1,
        stageResults: [{ stage: "", passed: true, durationMs: 1 }],
      },
    })) as unknown as VerifyCallback;
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 1,
      adapterHonorsAbort: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/non-empty string/);
  });

  test("rejects ok:true with passed:false summary (cross-field invariant)", async () => {
    const generate: GenerateCallback = async () => validRaw();
    const verify = (() => ({
      ok: true,
      summary: {
        passed: false,
        sandbox: false,
        totalDurationMs: 1,
        stageResults: [{ stage: "syntax", passed: false, durationMs: 1 }],
      },
    })) as unknown as VerifyCallback;
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 1,
      adapterHonorsAbort: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/passed:false/);
  });

  test("propagates verification summary into SynthesisOutput", async () => {
    const summary = {
      passed: true as const,
      sandbox: false,
      totalDurationMs: 17,
      stageResults: [{ stage: "syntax", passed: true, durationMs: 5 }],
    };
    const generate: GenerateCallback = async () => validRaw();
    const verify: VerifyCallback = () => ({ ok: true, summary });
    const result = await synthesize(INPUT, { generate, verify, ...ABORT_HONORED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verification).toEqual(summary);
  });

  test("first prompt does not contain refinement marker", async () => {
    const seen: string[] = [];
    const generate: GenerateCallback = async (p) => {
      seen.push(p);
      return validRaw();
    };
    await synthesize(INPUT, { generate, verify: ALWAYS_OK, ...ABORT_HONORED });
    expect(seen[0] ?? "").not.toContain("Previous failure reason");
  });

  test("default sanitizer drops verifier reason text from refinement prompt", async () => {
    // Verifier output crosses a trust boundary back into the LLM provider —
    // the default must NOT forward raw text. Callers must explicitly opt in
    // via sanitizeVerifierReason if they want the model to see diagnostics.
    const secret = "SUPER_SECRET_API_KEY=sk-leaked-12345";
    let attempt = 0;
    const seenPrompts: string[] = [];
    const generate: GenerateCallback = async (p) => {
      seenPrompts.push(p);
      return validRaw();
    };
    const verify: VerifyCallback = () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, reason: secret };
      return { ok: true };
    };
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 2,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    const refinementPrompt = seenPrompts[1] ?? "";
    expect(refinementPrompt).not.toContain(secret);
    expect(refinementPrompt).toContain("failure reason omitted");
  });

  test("opt-in sanitizer pass-through forwards verifier text (with redact cap)", async () => {
    const noisy = `verifier said: ${"X".repeat(500)}`;
    let attempt = 0;
    const seenPrompts: string[] = [];
    const generate: GenerateCallback = async (p) => {
      seenPrompts.push(p);
      return validRaw();
    };
    const verify: VerifyCallback = () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, reason: noisy };
      return { ok: true };
    };
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 2,
      sanitizeVerifierReason: (s) => s,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    const refinementPrompt = seenPrompts[1] ?? "";
    expect(refinementPrompt).toContain("verifier said");
    expect(refinementPrompt).toContain("truncated");
  });

  test("buggy sanitizer (throws) falls back to generic message", async () => {
    let attempt = 0;
    const verify: VerifyCallback = () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, reason: "boom" };
      return { ok: true };
    };
    const seenPrompts: string[] = [];
    const generate: GenerateCallback = async (p) => {
      seenPrompts.push(p);
      return validRaw();
    };
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 2,
      sanitizeVerifierReason: () => {
        throw new Error("sanitizer crashed");
      },
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    expect(seenPrompts[1] ?? "").toContain("failure reason omitted");
  });

  test("default sanitizer also drops generator failure text from refinement", async () => {
    const adapterSecret = "ADAPTER_TOKEN=tok-leak";
    let n = 0;
    const seenPrompts: string[] = [];
    const generate: GenerateCallback = async (p) => {
      seenPrompts.push(p);
      n += 1;
      if (n === 1) throw new Error(adapterSecret);
      return validRaw();
    };
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 2,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    const refinement = seenPrompts[1] ?? "";
    expect(refinement).not.toContain(adapterSecret);
    expect(refinement).toContain("failure reason omitted");
  });

  test("rejects oversized targetToolSchema before prompt construction", async () => {
    const huge = { type: "object", junk: "x".repeat(40_000) };
    const result = await synthesize(
      { ...INPUT, targetToolSchema: huge },
      { generate: async () => validRaw(), verify: ALWAYS_OK, maxAttempts: 1, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/targetToolSchema exceeds/);
  });

  test("rejects oversized candidate.description before prompt construction", async () => {
    const candidate: ForgeCandidate = { ...CANDIDATE, description: "x".repeat(5_000) };
    const result = await synthesize(
      { ...INPUT, candidate },
      { generate: async () => validRaw(), verify: ALWAYS_OK, maxAttempts: 1, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/candidate\.description exceeds/);
  });

  test("rejects ok:true verifier result whose stages contradict (passed but stage failed)", async () => {
    const summary = {
      passed: true as const,
      sandbox: false,
      totalDurationMs: 10,
      stageResults: [
        { stage: "syntax", passed: true, durationMs: 3 },
        { stage: "exec", passed: false, durationMs: 7 },
      ],
    };
    const verify: VerifyCallback = () => ({ ok: true, summary });
    const result = await synthesize(INPUT, {
      generate: async () => validRaw(),
      verify,
      maxAttempts: 1,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/conflicts with.*passed:false/);
  });

  test("verification summary is snapshotted (verifier cannot mutate audit data post-success)", async () => {
    const live: {
      passed: true;
      sandbox: boolean;
      totalDurationMs: number;
      stageResults: Array<{ stage: string; passed: boolean; durationMs: number }>;
    } = {
      passed: true,
      sandbox: false,
      totalDurationMs: 17,
      stageResults: [{ stage: "syntax", passed: true, durationMs: 5 }],
    };
    const verify: VerifyCallback = () => ({ ok: true, summary: live });
    const result = await synthesize(INPUT, {
      generate: async () => validRaw(),
      verify,
      maxAttempts: 1,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Verifier mutates its live reference AFTER synthesize() resolved.
    live.totalDurationMs = 9999;
    live.stageResults[0]!.passed = false;
    // Returned value must be unaffected.
    expect(result.value.verification?.totalDurationMs).toBe(17);
    expect(result.value.verification?.stageResults[0]?.passed).toBe(true);
    expect(Object.isFrozen(result.value.verification)).toBe(true);
  });

  test("targetToolSchema is snapshotted (caller mutation post-call has no effect)", async () => {
    const original: Record<string, unknown> = { type: "object", v: 1 };
    const generate: GenerateCallback = async () => {
      // Mutate the caller's original after generation has been triggered.
      // synthesize() should still equality-check against the snapshot,
      // not against the now-changed object.
      original.v = 2;
      return JSON.stringify({
        descriptor: {
          name: "echo_tool",
          description: "ok",
          // matches the ORIGINAL (snapshot), not the mutated value
          inputSchema: { type: "object", v: 1 },
        },
        code: "x();",
      });
    };
    const result = await synthesize(
      { ...INPUT, targetToolSchema: original },
      { generate, verify: ALWAYS_OK, maxAttempts: 1, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(true);
  });

  test("rejects deeply nested targetToolSchema (depth bound, no stack overflow)", async () => {
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) nested = { n: nested };
    const result = await synthesize(
      { ...INPUT, targetToolSchema: nested },
      { generate: async () => validRaw(), verify: ALWAYS_OK, maxAttempts: 1, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/max nesting depth|targetToolSchema/);
  });

  test("verifier mutating descriptor.name is rejected post-verification", async () => {
    const verify: VerifyCallback = (_code, descriptor) => {
      // Hostile mutation attempt — the descriptor passed in is frozen, so
      // this throws in strict mode (the JSON.parse JS context). synthesize()
      // must convert that throw into a typed verifier-failure path; the
      // test below exercises a sloppy-mode verifier that just reassigns.
      try {
        (descriptor as { name: string }).name = "evil_tool";
      } catch {
        /* descriptor is frozen */
      }
      return { ok: true };
    };
    const generate: GenerateCallback = async () => validRaw();
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 1,
      ...ABORT_HONORED,
    });
    // Either: descriptor was frozen so name still equals targetToolName
    // (success path), OR mutation slipped through and post-verify check
    // catches it (failure path). Both outcomes preserve the contract.
    if (result.ok) {
      expect(result.value.descriptor.name).toBe("echo_tool");
    } else {
      expect(result.reason).toMatch(/descriptor/);
    }
  });

  test("returned descriptor is frozen (cannot be mutated by caller)", async () => {
    const result = await synthesize(INPUT, {
      generate: async () => validRaw(),
      verify: ALWAYS_OK,
      maxAttempts: 1,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value.descriptor)).toBe(true);
    expect(Object.isFrozen(result.value.descriptor.inputSchema)).toBe(true);
  });

  test("rejects oversized model output before parsing (bounds parser cost)", async () => {
    const oversized = `${"{".repeat(300_000)}{}`;
    const generate: GenerateCallback = async () => oversized;
    const result = await synthesize(INPUT, {
      generate,
      verify: ALWAYS_OK,
      maxAttempts: 1,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/exceeds \d+ bytes/);
  });

  test("caps priorCode in refinement prompt (no oversized retry blowup)", async () => {
    const seenPrompts: string[] = [];
    const generate: GenerateCallback = async (p) => {
      seenPrompts.push(p);
      // first attempt: huge but valid JSON code field
      if (seenPrompts.length === 1) {
        return JSON.stringify({
          descriptor: { name: "echo_tool", description: "ok", inputSchema: { type: "object" } },
          code: "x".repeat(50_000),
        });
      }
      return validRaw();
    };
    let n = 0;
    const verify: VerifyCallback = () => {
      n += 1;
      return n === 1 ? { ok: false, reason: "nope" } : { ok: true };
    };
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 2,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(true);
    const refinement = seenPrompts[1] ?? "";
    expect(refinement).toContain("truncated");
    // refinement prompt should not carry the full 50KB priorCode
    expect(refinement.length).toBeLessThan(20_000);
  });

  test("rejects NaN attemptTimeoutMs (no silent timeout disable)", async () => {
    const result = await synthesize(INPUT, {
      generate: async () => validRaw(),
      verify: ALWAYS_OK,
      attemptTimeoutMs: Number.NaN,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/attemptTimeoutMs/);
    expect(result.attempts).toBe(0);
  });

  test("rejects negative attemptTimeoutMs", async () => {
    const result = await synthesize(INPUT, {
      generate: async () => validRaw(),
      verify: ALWAYS_OK,
      attemptTimeoutMs: -1,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/attemptTimeoutMs/);
  });

  test("hostile candidate.name (throwing getter) returns typed failure, not exception", async () => {
    const hostile: ForgeCandidate = Object.create(CANDIDATE, {
      name: {
        get: () => {
          throw new Error("hostile candidate getter");
        },
        enumerable: true,
      },
    }) as ForgeCandidate;
    const result = await synthesize(
      { ...INPUT, candidate: hostile },
      { generate: async () => validRaw(), verify: ALWAYS_OK, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/candidate/);
    expect(result.attempts).toBe(0);
  });

  test("candidate field of wrong type returns typed failure", async () => {
    const bad = { ...CANDIDATE, name: 123 as unknown as string };
    const result = await synthesize(
      { ...INPUT, candidate: bad },
      { generate: async () => validRaw(), verify: ALWAYS_OK, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/candidate\.name/);
  });

  test("zero remaining budget short-circuits — verify is never invoked", async () => {
    let now = 0;
    const clock = (): number => now;
    let verifyCalls = 0;
    const generate: GenerateCallback = () =>
      new Promise<string>((resolve) => {
        // generate consumes the entire budget
        now += 100;
        resolve(validRaw());
      });
    const verify: VerifyCallback = () => {
      verifyCalls += 1;
      return { ok: true };
    };
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 1,
      attemptTimeoutMs: 100,
      clock,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/timed out after 0ms/);
    expect(verifyCalls).toBe(0);
  });

  test("refinement prompt preserves candidate.proposedScope across retries", async () => {
    const seenPrompts: string[] = [];
    const generate: GenerateCallback = async (p) => {
      seenPrompts.push(p);
      return validRaw();
    };
    let n = 0;
    const verify: VerifyCallback = () => {
      n += 1;
      return n === 1 ? { ok: false, reason: "nope" } : { ok: true };
    };
    const candidate: ForgeCandidate = { ...CANDIDATE, proposedScope: "global" };
    const result = await synthesize(
      { ...INPUT, candidate },
      { generate, verify, maxAttempts: 2, ...ABORT_HONORED },
    );
    expect(result.ok).toBe(true);
    expect(seenPrompts[0] ?? "").toContain("global");
    expect(seenPrompts[1] ?? "").toContain("global");
  });

  test("attemptTimeoutMs is one budget across generate+verify (not double)", async () => {
    // generate consumes most of the budget; verify must inherit only what is
    // left, so total wall-clock per attempt stays inside attemptTimeoutMs.
    let now = 0;
    const clock = (): number => now;
    const generate: GenerateCallback = () =>
      new Promise<string>((resolve) => {
        // simulate generate taking 80ms inside an 100ms budget
        now += 80;
        resolve(validRaw());
      });
    const verify: VerifyCallback = () => new Promise<VerifyResult>(() => undefined); // never settles
    const result = await synthesize(INPUT, {
      generate,
      verify,
      maxAttempts: 1,
      attemptTimeoutMs: 100,
      clock,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // verify should have been given at most 20ms (the budget remainder).
    // Without the fix, it would have been given a fresh 100ms.
    expect(result.reason).toMatch(/timed out after (\d+)ms/);
    const match = result.reason.match(/timed out after (\d+)ms/);
    const ms = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
    expect(ms).toBeLessThanOrEqual(30);
  });

  test("hostile verifier object with throwing getter converts to typed failure", async () => {
    const hostile: VerifyCallback = () =>
      Object.create(null, {
        ok: {
          get() {
            throw new Error("hostile getter");
          },
          enumerable: true,
        },
      }) as never;
    const generate: GenerateCallback = async () => validRaw();
    const result = await synthesize(INPUT, {
      generate,
      verify: hostile,
      maxAttempts: 1,
      ...ABORT_HONORED,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/hostile|Verifier/);
  });
});
