import { describe, expect, test } from "bun:test";
import { CREDENTIAL_DENY_RULES, createCredentialDenyRules } from "./credential-deny-rules.js";
import { compileGlob } from "./rule-evaluator.js";

describe("CREDENTIAL_DENY_RULES", () => {
  test("contains 13 deny rules", () => {
    expect(CREDENTIAL_DENY_RULES).toHaveLength(13);
  });

  test("all rules have deny effect and wildcard action", () => {
    for (const rule of CREDENTIAL_DENY_RULES) {
      expect(rule.effect).toBe("deny");
      expect(rule.action).toBe("*");
      expect(rule.reason).toBeDefined();
    }
  });

  // Test each credential path is matched
  const denyPaths: readonly [string, string][] = [
    ["/home/user/.ssh/id_rsa", "**/.ssh/**"],
    ["/home/user/.ssh/authorized_keys", "**/.ssh/**"],
    ["/Users/dev/.docker/config.json", "**/.docker/**"],
    ["/home/user/.aws/credentials", "**/.aws/**"],
    ["/home/user/.aws/config", "**/.aws/**"],
    ["/home/user/.gnupg/secring.gpg", "**/.gnupg/**"],
    ["/home/user/.config/gcloud/credentials.db", "**/.config/gcloud/**"],
    ["/home/user/.azure/accessTokens.json", "**/.azure/**"],
    ["/home/user/.kube/config", "**/.kube/**"],
    ["/home/user/.npmrc", "**/.npmrc"],
    ["/home/user/.pypirc", "**/.pypirc"],
    ["/home/user/.netrc", "**/.netrc"],
    ["/home/user/.vault-token", "**/.vault-token"],
    ["/project/.env", "**/.env"],
    ["/project/.env.local", "**/.env.*"],
    ["/project/.env.production", "**/.env.*"],
  ];

  for (const [path, pattern] of denyPaths) {
    test(`pattern "${pattern}" matches "${path}"`, () => {
      const re = compileGlob(pattern);
      expect(re.test(path)).toBe(true);
    });
  }

  // Test safe paths are NOT matched by any credential rule
  const safePaths = [
    "/home/user/project/src/index.ts",
    "/home/user/project/.config/other/file.json",
    "/home/user/project/ssh/config",
    "/home/user/project/docker/Dockerfile",
    "/home/user/.config/Code/settings.json",
    "/home/user/project/env.ts",
    "/home/user/project/.environment",
  ];

  for (const path of safePaths) {
    test(`safe path "${path}" is not matched by any credential rule`, () => {
      const matched = CREDENTIAL_DENY_RULES.some((rule) => {
        const re = compileGlob(rule.pattern);
        return re.test(path);
      });
      expect(matched).toBe(false);
    });
  }
});

describe("createCredentialDenyRules", () => {
  test("stamps all rules with given source", () => {
    const rules = createCredentialDenyRules("policy");
    expect(rules).toHaveLength(CREDENTIAL_DENY_RULES.length);
    for (const rule of rules) {
      expect(rule.source).toBe("policy");
    }
  });

  test("preserves all original rule properties", () => {
    const rules = createCredentialDenyRules("project");
    for (let i = 0; i < rules.length; i++) {
      const original = CREDENTIAL_DENY_RULES[i];
      const sourced = rules[i];
      expect(sourced?.pattern).toBe(original?.pattern);
      expect(sourced?.action).toBe(original?.action);
      expect(sourced?.effect).toBe(original?.effect);
      expect(sourced?.reason).toBe(original?.reason);
      expect(sourced?.source).toBe("project");
    }
  });
});
