import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialComponent } from "@koi/core";

import { createSkillsRuntime } from "./index.js";
import { createScopedSkillsRuntime } from "./scoped-runtime.js";

async function writeSkillWithCredential(
  root: string,
  name: string,
  credKey: string,
): Promise<void> {
  const content = `---\nname: ${name}\ndescription: Test ${name}.\nrequires:\n  credentials:\n    primary:\n      kind: api_key\n      ref: ${credKey}\n---\n\n# ${name}\n\nBody.`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

async function writeSkillNoCredentials(root: string, name: string): Promise<void> {
  const content = `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n\nBody.`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

const credsAllowOpenAi: CredentialComponent = {
  async get(key) {
    return key === "openai_api_key" ? "sk-secret" : undefined;
  },
};

describe("createScopedSkillsRuntime — runtime-level credential gating (gov-15)", () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-scoped-runtime-test-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("discover() filters out skills whose credential ref is out of scope", async () => {
    await writeSkillWithCredential(userRoot, "ok-skill", "openai_api_key");
    await writeSkillWithCredential(userRoot, "blocked-skill", "stripe_secret");
    await writeSkillNoCredentials(userRoot, "no-cred-skill");

    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const gated = createScopedSkillsRuntime(base, credsAllowOpenAi);

    const result = await gated.discover();
    if (!result.ok) throw new Error(`discover failed: ${result.error.message}`);
    expect(result.value.has("ok-skill")).toBe(true);
    expect(result.value.has("no-cred-skill")).toBe(true);
    expect(result.value.has("blocked-skill")).toBe(false);
  });

  test("load() returns NOT_FOUND for out-of-scope skills (closes the Skill-tool bypass)", async () => {
    await writeSkillWithCredential(userRoot, "blocked-skill", "stripe_secret");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const gated = createScopedSkillsRuntime(base, credsAllowOpenAi);

    const result = await gated.load("blocked-skill");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    // The error message must not echo the credential value or the
    // underlying validation reason — agents see only "skill doesn't exist".
    expect(result.error.message).not.toContain("stripe");
    expect(result.error.message).not.toContain("VALIDATION");
  });

  test("load() returns the skill for in-scope refs", async () => {
    await writeSkillWithCredential(userRoot, "ok-skill", "openai_api_key");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const gated = createScopedSkillsRuntime(base, credsAllowOpenAi);

    const result = await gated.load("ok-skill");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("ok-skill");
    expect(result.value.body).toContain("Body.");
  });

  test("loadAll() filters out-of-scope skills as inner NOT_FOUND results", async () => {
    await writeSkillWithCredential(userRoot, "ok-skill", "openai_api_key");
    await writeSkillWithCredential(userRoot, "blocked-skill", "stripe_secret");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const gated = createScopedSkillsRuntime(base, credsAllowOpenAi);

    const result = await gated.loadAll();
    if (!result.ok) throw new Error("loadAll failed");
    const ok = result.value.get("ok-skill");
    const blocked = result.value.get("blocked-skill");
    expect(ok?.ok).toBe(true);
    expect(blocked?.ok).toBe(false);
    if (blocked?.ok === false) {
      expect(blocked.error.code).toBe("NOT_FOUND");
    }
  });

  test("query() filters out-of-scope skills", async () => {
    await writeSkillWithCredential(userRoot, "ok-skill", "openai_api_key");
    await writeSkillWithCredential(userRoot, "blocked-skill", "stripe_secret");
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const gated = createScopedSkillsRuntime(base, credsAllowOpenAi);

    const result = await gated.query();
    if (!result.ok) throw new Error("query failed");
    const names = result.value.map((s) => s.name);
    expect(names).toContain("ok-skill");
    expect(names).not.toContain("blocked-skill");
  });

  test("loadReference() refuses to serve sidecar files of out-of-scope skills", async () => {
    await writeSkillWithCredential(userRoot, "blocked-skill", "stripe_secret");
    await Bun.write(join(userRoot, "blocked-skill", "secret.txt"), "leak me");

    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const gated = createScopedSkillsRuntime(base, credsAllowOpenAi);

    const result = await gated.loadReference("blocked-skill", "secret.txt");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("skills with no credential requirements are visible regardless of scope", async () => {
    await writeSkillNoCredentials(userRoot, "anyone-skill");
    const restrictiveCreds: CredentialComponent = {
      async get() {
        return undefined;
      },
    };
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const gated = createScopedSkillsRuntime(base, restrictiveCreds);

    const discoverResult = await gated.discover();
    if (!discoverResult.ok) throw new Error("discover failed");
    expect(discoverResult.value.has("anyone-skill")).toBe(true);

    const loadResult = await gated.load("anyone-skill");
    expect(loadResult.ok).toBe(true);
  });

  test("revalidates credentials on every load — pinned/cached base bypass closed (round-5)", async () => {
    // Round-5 finding: when scope sat INSIDE the pinned runtime, a body
    // pinned at attach time was served from cache without re-checking
    // credentials, so a credential rotation/removal mid-session left
    // the pinned body reachable through the Skill tool. With scope
    // WRAPPING the runtime, every load() goes through the scope check
    // first regardless of base caching. Toggle credentials between
    // calls and assert the second call returns NOT_FOUND.
    await writeSkillWithCredential(userRoot, "rotating-skill", "openai_api_key");
    let allowOpenAi = true;
    const switchableCreds: CredentialComponent = {
      async get(key) {
        if (allowOpenAi && key === "openai_api_key") return "sk-secret";
        return undefined;
      },
    };
    const base = createSkillsRuntime({ bundledRoot: null, userRoot });
    const gated = createScopedSkillsRuntime(base, switchableCreds);

    const first = await gated.load("rotating-skill");
    expect(first.ok).toBe(true);

    allowOpenAi = false;

    const second = await gated.load("rotating-skill");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("NOT_FOUND");
  });
});
