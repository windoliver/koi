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

  test("returns file content for a valid reference path", async () => {
    await writeSkill(userRoot, "with-refs");
    await writeReference(userRoot, "with-refs", "references/rules.md", "rule content");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("with-refs", "references/rules.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("rule content");
  });

  test("returns NOT_FOUND for an unknown skill", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("does-not-exist", "references/x.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("rejects path traversal with VALIDATION / PATH_TRAVERSAL", async () => {
    await writeSkill(userRoot, "guarded");
    // Write a sibling outside the skill dir so the "escape" target exists.
    await Bun.write(join(userRoot, "sibling.txt"), "outside");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("guarded", "../sibling.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }
  });

  test("does not cache reference bodies between calls", async () => {
    await writeSkill(userRoot, "rewritable");
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
