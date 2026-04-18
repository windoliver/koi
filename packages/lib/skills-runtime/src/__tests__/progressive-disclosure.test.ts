/**
 * Progressive disclosure integration tests (issue #1642).
 *
 * Covers the Tier 0 / Tier 1 / Tier 2 + LRU + telemetry surface exposed by
 * createSkillsRuntime(). Filesystem-based, no mocks — exercises the factory
 * end-to-end so regressions in wiring show up here rather than in obscure
 * middleware paths.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillsRuntime } from "../index.js";
import type { SkillEvictedEvent, SkillLoadedEvent } from "../types.js";

async function writeSkill(root: string, name: string, body = ""): Promise<void> {
  const content = `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n\n${body}`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

async function writeSkillWithRefs(
  root: string,
  name: string,
  references: readonly string[],
): Promise<void> {
  // Empty array → inline `[]` so YAML parses as an array, not null.
  const refsBlock =
    references.length === 0
      ? "references: []\n"
      : `references:\n${references.map((r) => `  - ${r}`).join("\n")}\n`;
  const content = `---\nname: ${name}\ndescription: Test ${name}.\n${refsBlock}---\n\n# ${name}\n`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

async function writeReference(
  root: string,
  skill: string,
  relPath: string,
  content: string,
): Promise<void> {
  await Bun.write(join(root, skill, relPath), content, { createPath: true });
}

describe("progressive disclosure — telemetry", () => {
  let userRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-pd-user-"));
    projectRoot = await mkdtemp(join(tmpdir(), "koi-pd-project-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  test("Tier 0 metadata does not expose the Tier 2 references list (review #1896 round 6)", async () => {
    await writeSkillWithRefs(userRoot, "with-refs", ["refs/note.md"]);

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = result.value.get("with-refs");
    // The structural assertion: the property is intentionally absent from
    // SkillMetadata (Omit<ValidatedFrontmatter, "references">). Leaking it
    // would pre-disclose every reference path to the model at Tier 0.
    expect(meta).toBeDefined();
    expect((meta as unknown as Record<string, unknown>).references).toBeUndefined();
  });

  test("onMetadataInjected fires with the Tier 0 count on discover()", async () => {
    await writeSkill(userRoot, "alpha");
    await writeSkill(userRoot, "bravo");

    const counts: number[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      projectRoot,
      onMetadataInjected: (n) => counts.push(n),
    });

    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    expect(counts).toEqual([2]);
  });

  test("onMetadataInjected does NOT fire on internal discovery triggered by load/query/loadReference (review #1896 round 3)", async () => {
    await writeSkill(userRoot, "alpha");
    await writeReference(userRoot, "alpha", "refs/note.md", "ref content");

    const counts: number[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      projectRoot,
      onMetadataInjected: (n) => counts.push(n),
    });

    // Single explicit discover fires once.
    await runtime.discover();
    expect(counts).toEqual([1]);

    // Routine operations below must NOT re-fire the Tier 0 injection hook —
    // integrations use this callback to meter/inject the listing, and a replay
    // here would duplicate the full skill listing into context on every load.
    await runtime.load("alpha");
    await runtime.query();
    await runtime.loadReference("alpha", "refs/note.md");

    expect(counts).toEqual([1]);
  });

  test("onSkillLoaded distinguishes cache-miss from cache-hit", async () => {
    await writeSkill(userRoot, "lazy-load");

    const events: SkillLoadedEvent[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      projectRoot,
      onSkillLoaded: (e) => events.push(e),
    });

    await runtime.discover();
    const first = await runtime.load("lazy-load");
    expect(first.ok).toBe(true);
    const second = await runtime.load("lazy-load");
    expect(second.ok).toBe(true);

    // Two loads, each emits exactly one event: first=miss, second=hit.
    expect(events.length).toBe(2);
    expect(events[0]?.cacheHit).toBe(false);
    expect(events[0]?.name).toBe("lazy-load");
    expect(events[0]?.source).toBe("user");
    expect(events[0]?.bodyBytes).toBeGreaterThan(0);
    expect(events[1]?.cacheHit).toBe(true);
  });

  test("LRU eviction fires onSkillEvicted with reason 'lru'", async () => {
    await writeSkill(userRoot, "one");
    await writeSkill(userRoot, "two");
    await writeSkill(userRoot, "three");

    const evictions: SkillEvictedEvent[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      projectRoot,
      cacheMaxBodies: 2,
      onSkillEvicted: (e) => evictions.push(e),
    });

    await runtime.discover();
    await runtime.load("one");
    await runtime.load("two");
    await runtime.load("three"); // evicts "one" (LRU)

    expect(evictions).toEqual([{ name: "one", reason: "lru" }]);
  });

  test("invalidate(name) fires onSkillEvicted with reason 'invalidate'", async () => {
    await writeSkill(userRoot, "drop-me");

    const evictions: SkillEvictedEvent[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      projectRoot,
      onSkillEvicted: (e) => evictions.push(e),
    });

    await runtime.discover();
    await runtime.load("drop-me");
    runtime.invalidate("drop-me");

    expect(evictions).toEqual([{ name: "drop-me", reason: "invalidate" }]);
  });

  test("invalidate() (full reset) fires evictions for every cached body", async () => {
    await writeSkill(userRoot, "a");
    await writeSkill(userRoot, "b");

    const evictions: SkillEvictedEvent[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      projectRoot,
      onSkillEvicted: (e) => evictions.push(e),
    });

    await runtime.discover();
    await runtime.load("a");
    await runtime.load("b");
    runtime.invalidate();

    expect(evictions.length).toBe(2);
    expect(evictions.map((e) => e.name).sort()).toEqual(["a", "b"]);
    expect(evictions.every((e) => e.reason === "invalidate")).toBe(true);
  });

  test("unbounded cache (default) never evicts under pressure", async () => {
    for (let i = 0; i < 10; i++) await writeSkill(userRoot, `s${i}`);

    const evictions: SkillEvictedEvent[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      projectRoot,
      onSkillEvicted: (e) => evictions.push(e),
    });

    await runtime.discover();
    for (let i = 0; i < 10; i++) await runtime.load(`s${i}`);

    expect(evictions).toEqual([]);
  });
});

describe("progressive disclosure — loadReference (Tier 2)", () => {
  let userRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-pd-ref-user-"));
    projectRoot = await mkdtemp(join(tmpdir(), "koi-pd-ref-project-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  test("returns file content for a declared reference path", async () => {
    await writeSkillWithRefs(userRoot, "with-refs", ["references/rules.md"]);
    await writeReference(userRoot, "with-refs", "references/rules.md", "rule content");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("with-refs", "references/rules.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("rule content");
  });

  test("rejects skills with no declared references (review #1896 round 4)", async () => {
    // Skill with SKILL.md but no `references:` block. Undeclared surfaces
    // fail closed — the runtime must not hand out arbitrary in-tree files.
    await writeSkill(userRoot, "no-refs");
    await writeReference(userRoot, "no-refs", "secrets/.env", "KEY=abc");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("no-refs", "secrets/.env");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("rejects reference paths that are not in the declared allowlist (review #1896 round 4)", async () => {
    await writeSkillWithRefs(userRoot, "narrow", ["public/ok.md"]);
    await writeReference(userRoot, "narrow", "public/ok.md", "safe");
    await writeReference(userRoot, "narrow", "private/.env", "KEY=abc");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const allowed = await runtime.loadReference("narrow", "public/ok.md");
    expect(allowed.ok).toBe(true);

    const denied = await runtime.loadReference("narrow", "private/.env");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("PERMISSION");
  });

  test("returns NOT_FOUND for an unknown skill", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("does-not-exist", "references/x.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("rejects path traversal even for declared references (defense in depth)", async () => {
    // A declared path that itself contains `..` is rejected at the zod layer
    // before it can reach the filesystem. This test exercises the alternative
    // path: caller asks for a traversing path that is not declared, so the
    // allowlist denies first.
    await writeSkillWithRefs(userRoot, "guarded", ["references/ok.md"]);
    await writeReference(userRoot, "guarded", "references/ok.md", "ok");
    await Bun.write(join(userRoot, "sibling.txt"), "outside");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("guarded", "../sibling.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("allowlist revocation via SKILL.md edit + invalidate(name) takes effect immediately (review #1896 round 5)", async () => {
    // Initial skill declares a reference.
    await writeSkillWithRefs(userRoot, "revokable", ["refs/note.md"]);
    await writeReference(userRoot, "revokable", "refs/note.md", "v1");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    // First read succeeds.
    const before = await runtime.loadReference("revokable", "refs/note.md");
    expect(before.ok).toBe(true);

    // Operator edits SKILL.md to remove the reference, then calls
    // invalidate(name) per the contract. With the fix, the fresh
    // frontmatter read inside loadReference picks up the revocation.
    await writeSkillWithRefs(userRoot, "revokable", []);
    runtime.invalidate("revokable");

    const after = await runtime.loadReference("revokable", "refs/note.md");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("PERMISSION");
  });

  test("rejects unsupported extensions (.sh, .py) outright (review #1896 round 5)", async () => {
    await writeSkillWithRefs(userRoot, "scripts", ["scripts/run.sh"]);
    // Skill declares run.sh but the runtime refuses to surface shell files
    // — the scanner cannot AST-parse them, so Tier 2 must not serve them.
    await writeReference(userRoot, "scripts", "scripts/run.sh", "#!/bin/sh\necho hi\n");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("scripts", "scripts/run.sh");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({
        errorKind: "REFERENCE_UNSUPPORTED_EXTENSION",
      });
    }
  });

  test("does not cache reference bodies between calls", async () => {
    await writeSkillWithRefs(userRoot, "rewritable", ["refs/note.md"]);
    await writeReference(userRoot, "rewritable", "refs/note.md", "v1");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const first = await runtime.loadReference("rewritable", "refs/note.md");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toBe("v1");

    await writeReference(userRoot, "rewritable", "refs/note.md", "v2");
    const second = await runtime.loadReference("rewritable", "refs/note.md");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBe("v2");
  });
});
