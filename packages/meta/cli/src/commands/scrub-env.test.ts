/**
 * Regression tests for scrubSensitiveEnv — used by --until-pass mode to
 * strip Koi's own provider credentials before spawning the user-supplied
 * verifier subprocess (#1624 review rounds 7-8).
 *
 * Contract: block only Koi/model provider keys. Every other environment
 * variable — including unrelated project secrets like STRIPE_SECRET_KEY
 * or NEXTAUTH_SECRET — MUST pass through unchanged, because legitimate
 * test suites depend on them.
 */

import { describe, expect, test } from "bun:test";
import { scrubSensitiveEnv } from "./start.js";

describe("scrubSensitiveEnv", () => {
  test("blocks Koi provider credentials", () => {
    const scrubbed = scrubSensitiveEnv({
      OPENROUTER_API_KEY: "sk-openrouter-xxx",
      OPENAI_API_KEY: "sk-openai-xxx",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      GOOGLE_API_KEY: "ya29.xxx",
      GEMINI_API_KEY: "gm-xxx",
    });
    expect(scrubbed.OPENROUTER_API_KEY).toBeUndefined();
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.GOOGLE_API_KEY).toBeUndefined();
    expect(scrubbed.GEMINI_API_KEY).toBeUndefined();
  });

  test("regression: preserves UNRELATED project secrets so real test suites still work", () => {
    // These are the kinds of secrets a real bun test / pytest run needs.
    // The previous scrubber's substring matching would strip all of them
    // and silently break legitimate verifiers (#1624 review round 8).
    const scrubbed = scrubSensitiveEnv({
      NEXTAUTH_SECRET: "nextauth-dev-secret",
      STRIPE_SECRET_KEY: "sk_test_xxx",
      SLACK_BOT_TOKEN: "xoxb-xxx",
      DB_PASSWORD: "test-password",
      DATABASE_URL: "postgres://user:pass@localhost/db",
      GITHUB_TOKEN: "ghp_xxx",
      AWS_ACCESS_KEY_ID: "AKIA...",
    });
    expect(scrubbed.NEXTAUTH_SECRET).toBe("nextauth-dev-secret");
    expect(scrubbed.STRIPE_SECRET_KEY).toBe("sk_test_xxx");
    expect(scrubbed.SLACK_BOT_TOKEN).toBe("xoxb-xxx");
    expect(scrubbed.DB_PASSWORD).toBe("test-password");
    expect(scrubbed.DATABASE_URL).toBe("postgres://user:pass@localhost/db");
    expect(scrubbed.GITHUB_TOKEN).toBe("ghp_xxx");
    expect(scrubbed.AWS_ACCESS_KEY_ID).toBe("AKIA...");
  });

  test("preserves development-critical env vars", () => {
    const scrubbed = scrubSensitiveEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
      USER: "user",
      LANG: "en_US.UTF-8",
      NODE_ENV: "test",
      KOI_CONFIG: "/etc/koi.toml",
    });
    expect(scrubbed.PATH).toBe("/usr/bin:/bin");
    expect(scrubbed.HOME).toBe("/home/user");
    expect(scrubbed.USER).toBe("user");
    expect(scrubbed.LANG).toBe("en_US.UTF-8");
    expect(scrubbed.NODE_ENV).toBe("test");
    expect(scrubbed.KOI_CONFIG).toBe("/etc/koi.toml");
  });

  test("drops undefined values without error", () => {
    const scrubbed = scrubSensitiveEnv({
      PATH: "/usr/bin",
      SOMETHING_UNDEFINED: undefined,
    });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect("SOMETHING_UNDEFINED" in scrubbed).toBe(false);
  });
});
