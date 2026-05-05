import { describe, expect, mock, test } from "bun:test";
import type { ForgeCandidate } from "@koi/forge-types";
import { synthesize } from "./synthesize.js";
import type { GenerateCallback, SynthesisInput, VerifyCallback } from "./types.js";

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
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
    // refinement prompt should reference the prior failure reason
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

  test("rejects maxAttempts < 1", async () => {
    const result = await synthesize(INPUT, {
      generate: async () => "",
      verify: ALWAYS_OK,
      maxAttempts: 0,
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
    const result = await synthesize(INPUT, { generate, verify });
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

  test("forces single-shot when adapterHonorsAbort is false (default)", async () => {
    let calls = 0;
    const generate: GenerateCallback = async () => {
      calls += 1;
      return validRaw();
    };
    const verify: VerifyCallback = () => ({ ok: false, reason: "no" });
    // Caller explicitly asks for 5 attempts but did not assert hard abort —
    // synthesize must clamp to 1 to avoid overlapping side effects on retry.
    const result = await synthesize(INPUT, { generate, verify, maxAttempts: 5 });
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
      { generate, verify: ALWAYS_OK, maxAttempts: 1 },
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
      { generate, verify: ALWAYS_OK, maxAttempts: 1 },
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
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/timed out/);
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
    const result = await synthesize(INPUT, { generate, verify });
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
    const result = await synthesize(INPUT, { generate, verify });
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
    await synthesize(INPUT, { generate, verify: ALWAYS_OK });
    expect(seen[0] ?? "").not.toContain("Previous failure reason");
  });
});
