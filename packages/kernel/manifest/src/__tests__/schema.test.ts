import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
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
    expect(parse({ middleware: [{ "@koi/middleware-audit": { scope: "agent" } }] }).success).toBe(
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
        origin: "primordial",
        policy: DEFAULT_UNSANDBOXED_POLICY,
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

  test("rejects invalid defaultPolicy", () => {
    expect(parse({ forge: { defaultPolicy: "admin" } }).success).toBe(false);
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
      expect((forge.defaultPolicy as { sandbox: boolean }).sandbox).toBe(true);
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
// outboundWebhooks field
// ---------------------------------------------------------------------------

describe("rawManifestSchema — outboundWebhooks", () => {
  test("accepts valid outbound webhook array", () => {
    expect(
      parse({
        outboundWebhooks: [
          {
            url: "https://hooks.example.com/events",
            events: ["session.started", "session.ended"],
            secret: "s3cret",
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("accepts all valid event kinds", () => {
    expect(
      parse({
        outboundWebhooks: [
          {
            url: "https://hooks.example.com/events",
            events: [
              "session.started",
              "session.ended",
              "tool.failed",
              "tool.succeeded",
              "budget.warning",
              "budget.exhausted",
              "security.violation",
            ],
            secret: "my-secret",
          },
        ],
      }).success,
    ).toBe(true);
  });

  test("accepts optional description and enabled fields", () => {
    const result = parse({
      outboundWebhooks: [
        {
          url: "https://hooks.example.com/events",
          events: ["session.started"],
          secret: "s3cret",
          description: "Notify Slack on session start",
          enabled: false,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const hooks = (result.data as Record<string, unknown>).outboundWebhooks as readonly Record<
        string,
        unknown
      >[];
      expect(hooks[0]?.description).toBe("Notify Slack on session start");
      expect(hooks[0]?.enabled).toBe(false);
    }
  });

  test("accepts multiple outbound webhooks", () => {
    expect(
      parse({
        outboundWebhooks: [
          { url: "https://a.com/hook", events: ["session.started"], secret: "key-a" },
          { url: "https://b.com/hook", events: ["tool.failed"], secret: "key-b" },
        ],
      }).success,
    ).toBe(true);
  });

  test("rejects invalid URL", () => {
    expect(
      parse({
        outboundWebhooks: [{ url: "not-a-url", events: ["session.started"], secret: "s3cret" }],
      }).success,
    ).toBe(false);
  });

  test("rejects empty events array", () => {
    expect(
      parse({
        outboundWebhooks: [{ url: "https://hooks.example.com", events: [], secret: "s3cret" }],
      }).success,
    ).toBe(false);
  });

  test("rejects invalid event kind", () => {
    expect(
      parse({
        outboundWebhooks: [
          { url: "https://hooks.example.com", events: ["invalid.event"], secret: "s3cret" },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects empty secret", () => {
    expect(
      parse({
        outboundWebhooks: [
          { url: "https://hooks.example.com", events: ["session.started"], secret: "" },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects missing secret", () => {
    expect(
      parse({
        outboundWebhooks: [{ url: "https://hooks.example.com", events: ["session.started"] }],
      }).success,
    ).toBe(false);
  });

  test("rejects outboundWebhooks as string", () => {
    expect(parse({ outboundWebhooks: "https://hooks.example.com" }).success).toBe(false);
  });

  test("rejects outboundWebhooks as object (not array)", () => {
    expect(
      parse({
        outboundWebhooks: {
          url: "https://hooks.example.com",
          events: ["session.started"],
          secret: "s3cret",
        },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Channel identity
// ---------------------------------------------------------------------------

describe("rawManifestSchema — channel identity", () => {
  test("accepts channel with full identity block", () => {
    const result = parse({
      channels: [
        {
          name: "@koi/channel-telegram",
          identity: {
            name: "Alex",
            avatar: "casual.png",
            instructions: "Be casual and friendly.",
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts channel with partial identity (name only)", () => {
    const result = parse({
      channels: [{ name: "@koi/channel-telegram", identity: { name: "Alex" } }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts channel without identity block", () => {
    const result = parse({
      channels: [{ name: "@koi/channel-cli" }],
    });
    expect(result.success).toBe(true);
  });

  test("preserves identity fields in parsed result", () => {
    const result = parse({
      channels: [
        {
          name: "@koi/channel-slack",
          identity: { name: "Research Bot", instructions: "Be formal." },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { channels?: unknown[] };
      const ch = data.channels?.[0] as Record<string, unknown>;
      const identity = ch.identity as Record<string, unknown>;
      expect(identity.name).toBe("Research Bot");
      expect(identity.instructions).toBe("Be formal.");
    }
  });
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

describe("rawManifestSchema — skills", () => {
  test("accepts filesystem skill with source.kind and path", () => {
    const result = parse({
      skills: [
        { name: "code-review", source: { kind: "filesystem", path: "./skills/code-review" } },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts forged skill with source.kind and brickId", () => {
    const result = parse({
      skills: [{ name: "forged-review", source: { kind: "forged", brickId: "sha256:abc123" } }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts skills with options", () => {
    const result = parse({
      skills: [
        {
          name: "code-review",
          source: { kind: "filesystem", path: "./skills/code-review" },
          options: { verbose: true },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty skills array", () => {
    expect(parse({ skills: [] }).success).toBe(true);
  });

  test("rejects skill without name", () => {
    expect(
      parse({ skills: [{ source: { kind: "filesystem", path: "./skills/foo" } }] }).success,
    ).toBe(false);
  });

  test("rejects skill without source", () => {
    expect(parse({ skills: [{ name: "foo" }] }).success).toBe(false);
  });

  test("rejects skill with invalid source kind", () => {
    expect(
      parse({ skills: [{ name: "foo", source: { kind: "unknown", path: "./x" } }] }).success,
    ).toBe(false);
  });

  test("rejects old format with bare path (no source wrapper)", () => {
    expect(parse({ skills: [{ name: "foo", path: "./bar" }] }).success).toBe(false);
  });

  test("rejects skills as non-array", () => {
    expect(parse({ skills: "code-review" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Middleware required flag
// ---------------------------------------------------------------------------

describe("rawManifestSchema — middleware required flag", () => {
  test("accepts middleware with required: false in explicit form", () => {
    const result = parse({
      middleware: [{ name: "@koi/middleware-audit", required: false }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { middleware?: readonly Record<string, unknown>[] };
      expect(data.middleware?.[0]?.required).toBe(false);
    }
  });

  test("accepts middleware without required field (optional, defaults absent)", () => {
    const result = parse({
      middleware: [{ name: "@koi/middleware-permissions" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { middleware?: readonly Record<string, unknown>[] };
      expect(data.middleware?.[0]?.required).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Template expression rejection
// ---------------------------------------------------------------------------

describe("rawManifestSchema — template expression rejection", () => {
  test("accepts static model string", () => {
    expect(parse({ model: "anthropic:claude-sonnet-4-6" }).success).toBe(true);
  });

  test("accepts model with single-brace format string (allowed)", () => {
    // {region} is a format-string placeholder, not a Jinja/Django template expression
    expect(parse({ model: "custom-model-{region}" }).success).toBe(true);
  });

  test("rejects model with Jinja-style template {{...}}", () => {
    expect(parse({ model: "{{model}}" }).success).toBe(false);
  });

  test("rejects model with Django-style template {%...%}", () => {
    expect(parse({ model: "{% if condition %}sonnet{% endif %}" }).success).toBe(false);
  });

  test("rejects model with embedded Jinja expression", () => {
    expect(parse({ model: "model-{{env.MODEL}}" }).success).toBe(false);
  });

  test("rejects agent name with Jinja-style template", () => {
    expect(parse({ name: "{{agent_name}}" }).success).toBe(false);
  });

  test("rejects agent name with Django-style template", () => {
    expect(parse({ name: "{% block name %}my-agent{% endblock %}" }).success).toBe(false);
  });

  test("accepts static agent name", () => {
    expect(parse({ name: "my-production-agent" }).success).toBe(true);
  });

  test("rejects model object name with template expression", () => {
    expect(parse({ model: { name: "{{env.MODEL_NAME}}" } }).success).toBe(false);
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

// ---------------------------------------------------------------------------
// Context field (pass-through)
// ---------------------------------------------------------------------------

describe("rawManifestSchema — context field", () => {
  test("accepts context with explicit sources", () => {
    expect(parse({ context: { sources: [{ kind: "text", text: "hello" }] } }).success).toBe(true);
  });

  test("accepts context with bootstrap: true", () => {
    expect(parse({ context: { bootstrap: true } }).success).toBe(true);
  });

  test("accepts manifest without context", () => {
    expect(parse({}).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hooks field
// ---------------------------------------------------------------------------

describe("rawManifestSchema — hooks field", () => {
  test("accepts valid prompt hook", () => {
    const result = parse({
      hooks: [
        {
          kind: "prompt",
          name: "safety-check",
          prompt: "Is this action safe?",
          model: "haiku",
          failMode: "closed",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid command hook", () => {
    const result = parse({
      hooks: [
        {
          kind: "command",
          name: "audit-log",
          command: "echo audit",
          timeoutMs: 5000,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid http hook", () => {
    const result = parse({
      hooks: [
        {
          kind: "http",
          name: "webhook-check",
          url: "https://hooks.example.com/check",
          headers: { Authorization: "Bearer token" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid agent hook", () => {
    const result = parse({
      hooks: [
        {
          kind: "agent",
          name: "review-agent",
          prompt: "Review this change",
          maxTurns: 3,
          toolDenylist: ["dangerous_tool"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts multiple hooks of different kinds", () => {
    const result = parse({
      hooks: [
        { kind: "prompt", name: "check-1", prompt: "safe?" },
        { kind: "command", name: "check-2", command: "echo ok" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts hook with filter", () => {
    const result = parse({
      hooks: [
        {
          kind: "prompt",
          name: "tool-guard",
          prompt: "Is this tool call safe?",
          filter: {
            events: ["beforeToolCall"],
            toolNames: ["exec_command"],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts manifest without hooks", () => {
    expect(parse({}).success).toBe(true);
  });

  test("rejects hook with unknown kind", () => {
    const result = parse({
      hooks: [{ kind: "unknown", name: "bad" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects hook without name", () => {
    const result = parse({
      hooks: [{ kind: "prompt", prompt: "safe?" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects hook with empty name", () => {
    const result = parse({
      hooks: [{ kind: "prompt", name: "", prompt: "safe?" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects prompt hook without prompt field", () => {
    const result = parse({
      hooks: [{ kind: "prompt", name: "no-prompt" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects command hook without command field", () => {
    const result = parse({
      hooks: [{ kind: "command", name: "no-cmd" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid failMode", () => {
    const result = parse({
      hooks: [{ kind: "prompt", name: "x", prompt: "y", failMode: "maybe" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects typo in filter.events", () => {
    const result = parse({
      hooks: [
        {
          kind: "prompt",
          name: "guard",
          prompt: "safe?",
          filter: { events: ["beforeToolcall"] },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown filter event name", () => {
    const result = parse({
      hooks: [
        {
          kind: "command",
          name: "log",
          command: "echo ok",
          filter: { events: ["onStartup"] },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
