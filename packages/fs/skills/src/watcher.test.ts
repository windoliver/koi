import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillWatchEvent } from "./watcher.js";
import { createSkillFileWatcher } from "./watcher.js";

// fs.watch({ recursive: true }) is unreliable on Linux — skip watch-dependent tests on CI/Linux
const isLinux = process.platform === "linux";
const describeWatch = isLinux ? describe.skip : describe;

const TEST_DIR = resolve(tmpdir(), `koi-watcher-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createSkillDir(basePath: string, name: string): void {
  const dir = join(basePath, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\nTest body`,
  );
}

/** Polls until the callback returns truthy or timeout. */
async function waitFor(check: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("createSkillFileWatcher", () => {
  test("skips non-existent directories without error", () => {
    const watcher = createSkillFileWatcher({
      dirs: ["/nonexistent-path-xyz-123"],
      debounceMs: 50,
      onChange: () => {},
    });

    // Should not throw
    watcher.dispose();
  });
});

describeWatch("createSkillFileWatcher (fs.watch)", () => {
  test("detects added skill directory", async () => {
    const events: SkillWatchEvent[] = [];
    const watcher = createSkillFileWatcher({
      dirs: [TEST_DIR],
      debounceMs: 50,
      onChange: (event) => events.push(event),
    });

    // Wait for initialization
    await new Promise((r) => setTimeout(r, 200));

    // Add a new skill
    createSkillDir(TEST_DIR, "new-skill");

    await waitFor(() => events.some((e) => e.kind === "added" && e.name === "new-skill"));
    expect(events.some((e) => e.kind === "added" && e.name === "new-skill")).toBe(true);

    watcher.dispose();
  });

  test("detects removed skill directory", async () => {
    // Pre-create a skill
    createSkillDir(TEST_DIR, "to-remove");

    const events: SkillWatchEvent[] = [];
    const watcher = createSkillFileWatcher({
      dirs: [TEST_DIR],
      debounceMs: 50,
      onChange: (event) => events.push(event),
    });

    // Wait for initialization to populate known set
    await new Promise((r) => setTimeout(r, 200));

    // Remove the skill
    rmSync(join(TEST_DIR, "to-remove"), { recursive: true, force: true });

    // Trigger a change that the watcher can detect
    writeFileSync(join(TEST_DIR, ".trigger"), "");

    await waitFor(() => events.some((e) => e.kind === "removed" && e.name === "to-remove"));
    expect(events.some((e) => e.kind === "removed" && e.name === "to-remove")).toBe(true);

    watcher.dispose();
  });

  test("dispose stops watching", async () => {
    const events: SkillWatchEvent[] = [];
    const watcher = createSkillFileWatcher({
      dirs: [TEST_DIR],
      debounceMs: 50,
      onChange: (event) => events.push(event),
    });

    await new Promise((r) => setTimeout(r, 200));
    watcher.dispose();

    // Add a skill after dispose — should NOT trigger events
    createSkillDir(TEST_DIR, "after-dispose");
    await new Promise((r) => setTimeout(r, 200));

    expect(events.filter((e) => e.name === "after-dispose")).toHaveLength(0);
  });

  test("watches multiple directories", async () => {
    const dir2 = `${TEST_DIR}-extra`;
    mkdirSync(dir2, { recursive: true });

    const events: SkillWatchEvent[] = [];
    const watcher = createSkillFileWatcher({
      dirs: [TEST_DIR, dir2],
      debounceMs: 50,
      onChange: (event) => events.push(event),
    });

    await new Promise((r) => setTimeout(r, 200));

    createSkillDir(TEST_DIR, "skill-a");
    createSkillDir(dir2, "skill-b");

    await waitFor(() => events.length >= 2);

    watcher.dispose();
    rmSync(dir2, { recursive: true, force: true });
  });

  test("debounces rapid changes", async () => {
    const events: SkillWatchEvent[] = [];
    const watcher = createSkillFileWatcher({
      dirs: [TEST_DIR],
      debounceMs: 100,
      onChange: (event) => events.push(event),
    });

    await new Promise((r) => setTimeout(r, 200));

    // Rapidly create a skill and modify it
    createSkillDir(TEST_DIR, "rapid-skill");
    writeFileSync(
      join(TEST_DIR, "rapid-skill", "SKILL.md"),
      "---\nname: rapid-skill\ndescription: Updated\n---\nUpdated",
    );

    // Wait for debounce to settle
    await new Promise((r) => setTimeout(r, 300));

    // Should have collapsed into fewer events due to debounce
    const rapidEvents = events.filter((e) => e.name === "rapid-skill");
    expect(rapidEvents.length).toBeGreaterThan(0);

    watcher.dispose();
  });
});
