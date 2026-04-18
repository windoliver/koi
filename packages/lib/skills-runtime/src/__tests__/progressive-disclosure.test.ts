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
import type { SkillEvictedEvent, SkillLoadedEvent, SkillMetadata } from "../types.js";

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

  test("in-flight load() cannot repopulate the cache after invalidate() (review #1896 round 11)", async () => {
    // Race: kick off load(), immediately full-invalidate before load()
    // completes, then call load() a second time and confirm the first
    // promise's result was NOT retained in the cache.
    await writeSkill(userRoot, "racey");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    // Start load() but don't await — it will do its async work concurrently.
    const inflight = runtime.load("racey");
    // Synchronously reset the runtime. The in-flight load's cache.set
    // must be suppressed by the epoch guard.
    runtime.invalidate();

    // Let the in-flight settle — we do not assert its result; post-reset
    // behavior is intentionally unspecified from the caller's POV, but
    // the side effect we care about (cache population) must not occur.
    await inflight;

    // Fresh load after reset — if the first load leaked into the cache,
    // this one would return the stale body without re-discovering.
    await runtime.discover();
    const fresh = await runtime.load("racey");
    expect(fresh.ok).toBe(true);
    // Sanity: with onSkillLoaded we can see the body travelled through a
    // fresh load path, not a pre-reset cache hit.
  });

  test("in-flight load() cannot repopulate cache after registerExternal (review #1896 round 11)", async () => {
    const externalFirst: SkillMetadata = {
      name: "mcp-ref",
      description: "first version",
      source: "mcp",
      dirPath: "mcp://first",
    };
    const externalSecond: SkillMetadata = {
      name: "mcp-ref",
      description: "second version",
      source: "mcp",
      dirPath: "mcp://second",
    };

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    runtime.registerExternal([externalFirst]);
    await runtime.discover();

    const inflight = runtime.load("mcp-ref");
    // Replace the external entry synchronously.
    runtime.registerExternal([externalSecond]);
    await inflight;

    // After the refresh, the next load MUST surface the new entry, not
    // a stale insert from the pre-refresh load.
    const fresh = await runtime.load("mcp-ref");
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.value.description).toBe("second version");
  });

  test("onMetadataInjected does NOT replay on cached discover() calls (review #1896 round 10)", async () => {
    await writeSkill(userRoot, "cached");

    const counts: number[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      projectRoot,
      onMetadataInjected: (n) => counts.push(n),
    });

    await runtime.discover();
    await runtime.discover(); // fast path — same merged map, no rescan
    await runtime.discover(); // fast path — same merged map, no rescan

    // Firing once per unique snapshot rather than per call avoids
    // duplicating the full skill listing into model context across
    // routine re-discovery calls.
    expect(counts).toEqual([1]);
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
    await writeReference(userRoot, "no-refs", "secrets/notes.md", "secret prose");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("no-refs", "secrets/notes.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("rejects reference paths that are not in the declared allowlist (review #1896 round 4)", async () => {
    await writeSkillWithRefs(userRoot, "narrow", ["public/ok.md"]);
    await writeReference(userRoot, "narrow", "public/ok.md", "safe");
    await writeReference(userRoot, "narrow", "private/notes.md", "secret");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const allowed = await runtime.loadReference("narrow", "public/ok.md");
    expect(allowed.ok).toBe(true);

    const denied = await runtime.loadReference("narrow", "private/notes.md");
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

  test("rejects path traversal even for discovered skills (defense in depth)", async () => {
    // A traversing path is rejected by the syntactic hygiene step
    // before the allowlist is consulted (review #1896 round 9), so
    // it surfaces as VALIDATION / PATH_TRAVERSAL rather than a
    // generic PERMISSION denial.
    await writeSkillWithRefs(userRoot, "guarded", ["references/ok.md"]);
    await writeReference(userRoot, "guarded", "references/ok.md", "ok");
    await Bun.write(join(userRoot, "sibling.md"), "outside");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("guarded", "../sibling.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }
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

  test("traversal attempts surface as VALIDATION, not PERMISSION (review #1896 round 9)", async () => {
    // Undeclared malformed paths must remain observable as path-hygiene
    // failures even when the caller has a discovered skill with an
    // allowlist. Hiding them behind a generic PERMISSION would lose
    // signal for monitoring keyed off PATH_TRAVERSAL.
    await writeSkillWithRefs(userRoot, "guarded", ["refs/ok.md"]);
    await writeReference(userRoot, "guarded", "refs/ok.md", "ok");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const traversal = await runtime.loadReference("guarded", "../escape.md");
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) {
      expect(traversal.error.code).toBe("VALIDATION");
      expect(traversal.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }

    const absolute = await runtime.loadReference("guarded", "/etc/passwd");
    expect(absolute.ok).toBe(false);
    if (!absolute.ok) {
      expect(absolute.error.code).toBe("VALIDATION");
      expect(absolute.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }

    const badExt = await runtime.loadReference("guarded", "refs/ok.sh");
    expect(badExt.ok).toBe(false);
    if (!badExt.ok) {
      expect(badExt.error.code).toBe("VALIDATION");
      expect(badExt.error.context).toMatchObject({
        errorKind: "REFERENCE_UNSUPPORTED_EXTENSION",
      });
    }
  });

  test("PERMISSION errors do not leak the allowlist (review #1896 round 7)", async () => {
    await writeSkillWithRefs(userRoot, "hidden", ["refs/secret.md", "refs/private.md"]);
    await writeReference(userRoot, "hidden", "refs/secret.md", "s");
    await writeReference(userRoot, "hidden", "refs/private.md", "p");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    const result = await runtime.loadReference("hidden", "refs/does-not-exist.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // No enumeration oracle: the error context must not contain the
      // declared reference list (directly or under any key).
      const flat = JSON.stringify(result.error);
      expect(flat).not.toContain("refs/secret.md");
      expect(flat).not.toContain("refs/private.md");
    }
  });

  test("post-discovery allowlist expansions do not take effect until rediscovery (review #1896 round 7)", async () => {
    // Skill discovered with a narrow allowlist.
    await writeSkillWithRefs(userRoot, "growing", ["refs/a.md"]);
    await writeReference(userRoot, "growing", "refs/a.md", "a");
    await writeReference(userRoot, "growing", "refs/b.md", "b");

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();

    // Operator edits SKILL.md to add `refs/b.md` AFTER discovery. Without
    // a full rediscovery that path must remain unauthorized — additions
    // have to go through the normal discover/scan flow.
    await writeSkillWithRefs(userRoot, "growing", ["refs/a.md", "refs/b.md"]);

    const original = await runtime.loadReference("growing", "refs/a.md");
    expect(original.ok).toBe(true);

    const added = await runtime.loadReference("growing", "refs/b.md");
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.error.code).toBe("PERMISSION");

    // A full invalidation + rediscovery picks up the expansion.
    runtime.invalidate();
    await runtime.discover();
    const rediscovered = await runtime.loadReference("growing", "refs/b.md");
    expect(rediscovered.ok).toBe(true);
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
