import { describe, expect, test } from "bun:test";
import { rawManifestSchema, zodToKoiError } from "../schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid manifest base — extend with field under test. */
const BASE = {
  name: "my-agent",
  version: "1.0.0",
  model: "anthropic:claude-sonnet-4-5-20250929",
} as const;

function parse(extra: Record<string, unknown> = {}): {
  success: boolean;
  data?: unknown;
  error?: unknown;
} {
  return rawManifestSchema.safeParse({ ...BASE, ...extra });
}

// ---------------------------------------------------------------------------
// Core fields
// ---------------------------------------------------------------------------

describe("rawManifestSchema — core fields", () => {
  test("accepts minimal valid manifest", () => {
    expect(parse().success).toBe(true);
  });

  test("accepts model as object", () => {
    expect(
      parse({
        model: { name: "anthropic:claude-sonnet-4-5-20250929", options: { temperature: 0.7 } },
      }).success,
    ).toBe(true);
  });

  test("rejects missing name", () => {
    const result = rawManifestSchema.safeParse({ version: "1.0.0", model: "m" });
    expect(result.success).toBe(false);
  });

  test("rejects missing version", () => {
    const result = rawManifestSchema.safeParse({ name: "a", model: "m" });
    expect(result.success).toBe(false);
  });

  test("rejects missing model", () => {
    const result = rawManifestSchema.safeParse({ name: "a", version: "1.0.0" });
    expect(result.success).toBe(false);
  });

  test("rejects model as number", () => {
    expect(parse({ model: 42 }).success).toBe(false);
  });

  test("accepts middleware as key-value array", () => {
    expect(parse({ middleware: [{ "@koi/middleware-memory": { scope: "agent" } }] }).success).toBe(
      true,
    );
  });

  test("accepts tools with mcp section", () => {
    expect(
      parse({
        tools: {
          mcp: [{ name: "filesystem", command: "npx @anthropic/mcp-server-filesystem /workspace" }],
        },
      }).success,
    ).toBe(true);
  });

  test("accepts permissions", () => {
    expect(
      parse({
        permissions: {
          allow: ["read_file:/workspace/**"],
          deny: ["bash:rm -rf *"],
          ask: ["bash:*"],
        },
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// engine field
// ---------------------------------------------------------------------------

describe("rawManifestSchema — engine", () => {
  test("accepts engine as string", () => {
    const result = parse({ engine: "deepagents" });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).engine).toBe("deepagents");
  });

  test("accepts engine as object", () => {
    expect(parse({ engine: { name: "langgraph", options: { graph: "main" } } }).success).toBe(true);
  });

  test("rejects engine as number", () => {
    expect(parse({ engine: 42 }).success).toBe(false);
  });

  test("rejects engine as boolean", () => {
    expect(parse({ engine: true }).success).toBe(false);
  });

  test("rejects engine object without name", () => {
    expect(parse({ engine: { options: {} } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// schedule field
// ---------------------------------------------------------------------------

describe("rawManifestSchema — schedule", () => {
  test("accepts valid cron string", () => {
    const result = parse({ schedule: "0 9 * * *" });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).schedule).toBe("0 9 * * *");
  });

  test("accepts another cron string", () => {
    expect(parse({ schedule: "*/5 * * * *" }).success).toBe(true);
  });

  test("rejects schedule as number", () => {
    expect(parse({ schedule: 42 }).success).toBe(false);
  });

  test("rejects schedule as object", () => {
    expect(parse({ schedule: { cron: "0 9 * * *" } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhooks field
// ---------------------------------------------------------------------------

describe("rawManifestSchema — webhooks", () => {
  test("accepts valid webhook array", () => {
    expect(
      parse({
        webhooks: [{ path: "/hooks/github", events: ["push", "pull_request"], secret: "s3cret" }],
      }).success,
    ).toBe(true);
  });

  test("accepts minimal webhook (path only)", () => {
    expect(parse({ webhooks: [{ path: "/events" }] }).success).toBe(true);
  });

  test("accepts multiple webhooks", () => {
    expect(
      parse({
        webhooks: [{ path: "/hooks/a" }, { path: "/hooks/b", events: ["push"] }],
      }).success,
    ).toBe(true);
  });

  test("rejects webhook without path", () => {
    expect(parse({ webhooks: [{ events: ["push"] }] }).success).toBe(false);
  });

  test("rejects webhook with path not starting with /", () => {
    expect(parse({ webhooks: [{ path: "hooks/github" }] }).success).toBe(false);
  });

  test("rejects webhooks as string", () => {
    expect(parse({ webhooks: "/hooks/github" }).success).toBe(false);
  });

  test("rejects webhooks as object (not array)", () => {
    expect(parse({ webhooks: { path: "/hooks" } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forge field
// ---------------------------------------------------------------------------

describe("rawManifestSchema — forge", () => {
  test("accepts full forge config", () => {
    const result = parse({
      forge: {
        enabled: true,
        maxForgeDepth: 2,
        maxForgesPerSession: 10,
        defaultScope: "zone",
        trustTier: "verified",
        scopePromotion: {
          requireHumanApproval: false,
          minTrustForZone: "sandbox",
          minTrustForGlobal: "verified",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts minimal forge config (all defaults)", () => {
    expect(parse({ forge: {} }).success).toBe(true);
  });

  test("accepts forge with only enabled", () => {
    expect(parse({ forge: { enabled: false } }).success).toBe(true);
  });

  test("rejects negative maxForgeDepth", () => {
    expect(parse({ forge: { maxForgeDepth: -1 } }).success).toBe(false);
  });

  test("rejects zero maxForgesPerSession", () => {
    expect(parse({ forge: { maxForgesPerSession: 0 } }).success).toBe(false);
  });

  test("rejects invalid defaultScope", () => {
    expect(parse({ forge: { defaultScope: "cluster" } }).success).toBe(false);
  });

  test("rejects invalid trustTier", () => {
    expect(parse({ forge: { trustTier: "admin" } }).success).toBe(false);
  });

  test("rejects forge as string", () => {
    expect(parse({ forge: "enabled" }).success).toBe(false);
  });

  test("applies default values for forge", () => {
    const result = parse({ forge: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      const forge = (result.data as Record<string, unknown>).forge as Record<string, unknown>;
      expect(forge.enabled).toBe(true);
      expect(forge.maxForgeDepth).toBe(1);
      expect(forge.maxForgesPerSession).toBe(5);
      expect(forge.defaultScope).toBe("agent");
      expect(forge.trustTier).toBe("sandbox");
    }
  });
});

// ---------------------------------------------------------------------------
// deploy field
// ---------------------------------------------------------------------------

describe("rawManifestSchema — deploy", () => {
  test("accepts full deploy config", () => {
    const result = parse({
      deploy: {
        port: 8080,
        restart: "always",
        restartDelaySec: 10,
        envFile: ".env.production",
        logDir: "/var/log/koi",
        system: true,
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts minimal deploy config (all defaults)", () => {
    const result = parse({ deploy: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      const deploy = (result.data as Record<string, unknown>).deploy as Record<string, unknown>;
      expect(deploy.port).toBe(9100);
      expect(deploy.restart).toBe("on-failure");
      expect(deploy.restartDelaySec).toBe(5);
      expect(deploy.system).toBe(false);
    }
  });

  test("accepts port boundary: 1", () => {
    expect(parse({ deploy: { port: 1 } }).success).toBe(true);
  });

  test("accepts port boundary: 65535", () => {
    expect(parse({ deploy: { port: 65535 } }).success).toBe(true);
  });

  test("rejects port 0", () => {
    expect(parse({ deploy: { port: 0 } }).success).toBe(false);
  });

  test("rejects port 70000", () => {
    expect(parse({ deploy: { port: 70000 } }).success).toBe(false);
  });

  test("rejects negative port", () => {
    expect(parse({ deploy: { port: -1 } }).success).toBe(false);
  });

  test("rejects port as string", () => {
    expect(parse({ deploy: { port: "8080" } }).success).toBe(false);
  });

  test("accepts restart: on-failure", () => {
    expect(parse({ deploy: { restart: "on-failure" } }).success).toBe(true);
  });

  test("accepts restart: always", () => {
    expect(parse({ deploy: { restart: "always" } }).success).toBe(true);
  });

  test("accepts restart: no", () => {
    expect(parse({ deploy: { restart: "no" } }).success).toBe(true);
  });

  test("rejects invalid restart policy", () => {
    expect(parse({ deploy: { restart: "never" } }).success).toBe(false);
  });

  test("rejects negative restartDelaySec", () => {
    expect(parse({ deploy: { restartDelaySec: -1 } }).success).toBe(false);
  });

  test("accepts restartDelaySec: 0", () => {
    expect(parse({ deploy: { restartDelaySec: 0 } }).success).toBe(true);
  });

  test("rejects deploy as string", () => {
    expect(parse({ deploy: "production" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// soul field
// ---------------------------------------------------------------------------

describe("rawManifestSchema — soul", () => {
  test("accepts soul as string path", () => {
    const result = parse({ soul: "./SOUL.md" });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).soul).toBe("./SOUL.md");
  });

  test("accepts soul as object with path and maxTokens", () => {
    expect(parse({ soul: { path: "./soul/", maxTokens: 2000 } }).success).toBe(true);
  });

  test("accepts soul as inline multiline string", () => {
    expect(parse({ soul: "You are helpful.\nBe concise." }).success).toBe(true);
  });

  test("accepts soul object with path only (no maxTokens)", () => {
    expect(parse({ soul: { path: "./SOUL.md" } }).success).toBe(true);
  });

  test("rejects soul as number", () => {
    expect(parse({ soul: 42 }).success).toBe(false);
  });

  test("rejects soul as boolean", () => {
    expect(parse({ soul: true }).success).toBe(false);
  });

  test("rejects soul object without path", () => {
    expect(parse({ soul: { maxTokens: 2000 } }).success).toBe(false);
  });

  test("rejects soul with negative maxTokens", () => {
    expect(parse({ soul: { path: "./SOUL.md", maxTokens: -1 } }).success).toBe(false);
  });

  test("rejects soul with zero maxTokens", () => {
    expect(parse({ soul: { path: "./SOUL.md", maxTokens: 0 } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// user field
// ---------------------------------------------------------------------------

describe("rawManifestSchema — user", () => {
  test("accepts user as string path", () => {
    const result = parse({ user: "./USER.md" });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).user).toBe("./USER.md");
  });

  test("accepts user as object with path and maxTokens", () => {
    expect(parse({ user: { path: "./USER.md", maxTokens: 1000 } }).success).toBe(true);
  });

  test("rejects user as number", () => {
    expect(parse({ user: 42 }).success).toBe(false);
  });

  test("rejects user as array", () => {
    expect(parse({ user: ["./USER.md"] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// zodToKoiError
// ---------------------------------------------------------------------------

describe("zodToKoiError", () => {
  test("converts ZodError to KoiError with VALIDATION code", () => {
    const result = rawManifestSchema.safeParse({ model: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const koiError = zodToKoiError(result.error);
      expect(koiError.code).toBe("VALIDATION");
      expect(koiError.retryable).toBe(false);
      expect(koiError.message).toContain("Validation failed");
      expect(koiError.context).toBeDefined();
    }
  });
});
