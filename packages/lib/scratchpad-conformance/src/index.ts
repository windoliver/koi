import { describe, expect, test } from "bun:test";
import type { ScratchpadChangeEvent, ScratchpadComponent } from "@koi/core";
import { scratchpadPath } from "@koi/core";

/**
 * Factory for fresh, never-touched ScratchpadComponent instances.
 *
 * MUST return a brand-new component on each call so tests don't share state.
 * The factory may be async (network adapters, transport probes, etc.).
 */
export type ScratchpadFactory = () => Promise<ScratchpadComponent> | ScratchpadComponent;

async function testWriteRead(factory: ScratchpadFactory): Promise<void> {
  const pad = await factory();
  const path = scratchpadPath("notes/round-trip");
  const wrote = await pad.write({ path, content: "hello" });
  expect(wrote.ok).toBe(true);
  if (!wrote.ok) return;
  expect(wrote.value.generation).toBe(1);
  expect(wrote.value.sizeBytes).toBe(5);

  const read = await pad.read(path);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.value.content).toBe("hello");
  expect(read.value.generation).toBe(1);
  expect(read.value.path).toBe(path);
}

async function testReadMissing(factory: ScratchpadFactory): Promise<void> {
  const pad = await factory();
  const result = await pad.read(scratchpadPath("missing/path"));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
}

async function testOverwriteIncrements(factory: ScratchpadFactory): Promise<void> {
  const pad = await factory();
  const path = scratchpadPath("notes/inc");
  const a = await pad.write({ path, content: "v1" });
  const b = await pad.write({ path, content: "v2" });
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok || !b.ok) return;
  expect(b.value.generation).toBe(a.value.generation + 1);
  const read = await pad.read(path);
  if (read.ok) expect(read.value.content).toBe("v2");
}

async function testCasCreateOnly(factory: ScratchpadFactory): Promise<void> {
  const pad = await factory();
  const path = scratchpadPath("cas/create-only");
  const first = await pad.write({ path, content: "first" });
  expect(first.ok).toBe(true);
  const second = await pad.write({ path, content: "second", expectedGeneration: 0 });
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.error.code).toBe("CONFLICT");
}

async function testCasStale(factory: ScratchpadFactory): Promise<void> {
  const pad = await factory();
  const path = scratchpadPath("cas/stale");
  const a = await pad.write({ path, content: "v1" });
  if (!a.ok) return;
  const ok = await pad.write({
    path,
    content: "v2",
    expectedGeneration: a.value.generation,
  });
  expect(ok.ok).toBe(true);
  const stale = await pad.write({
    path,
    content: "v3",
    expectedGeneration: a.value.generation,
  });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");
}

async function testDelete(factory: ScratchpadFactory): Promise<void> {
  const pad = await factory();
  const path = scratchpadPath("delete/me");
  await pad.write({ path, content: "x" });
  const del = await pad.delete(path);
  expect(del.ok).toBe(true);
  const read = await pad.read(path);
  expect(read.ok).toBe(false);
  const list = await pad.list();
  expect(list.some((e) => e.path === path)).toBe(false);
}

async function testListSummaries(factory: ScratchpadFactory): Promise<void> {
  const pad = await factory();
  const a = scratchpadPath("list/a");
  const b = scratchpadPath("list/b");
  await pad.write({ path: a, content: "AAA" });
  await pad.write({ path: b, content: "BBBB" });
  const list = await pad.list();
  const paths = list.map((e) => e.path).sort();
  expect(paths).toContain(a);
  expect(paths).toContain(b);
  for (const summary of list) {
    expect(Object.hasOwn(summary, "content")).toBe(false);
  }
}

async function testOnChangeEventual(factory: ScratchpadFactory): Promise<void> {
  // Poll-based adapters legitimately coalesce intervening writes into a
  // single event for the latest generation, while push-based adapters
  // emit one per write. The contract guarantees only that subscribers
  // *eventually* observe the latest state — not how many events that
  // takes — so the suite asserts the eventual outcome, not the count.
  const pad = await factory();
  const events: ScratchpadChangeEvent[] = [];
  const unsub = pad.onChange((e) => events.push(e));
  try {
    const path = scratchpadPath("events/written");
    await pad.write({ path, content: "v1" });
    await pad.write({ path, content: "v2" });
    await new Promise((r) => setTimeout(r, 200));
    const writes = events.filter((e) => e.kind === "written" && e.path === path);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const last = writes[writes.length - 1];
    if (last) expect(last.generation).toBeGreaterThanOrEqual(2);
  } finally {
    unsub();
  }
}

async function testOnChangeNoReplay(factory: ScratchpadFactory): Promise<void> {
  const pad = await factory();
  const path = scratchpadPath("events/no-replay");
  // Seed before any subscriber attaches — must not be replayed.
  await pad.write({ path, content: "pre-existing" });

  const events: ScratchpadChangeEvent[] = [];
  const unsub = pad.onChange((e) => events.push(e));
  try {
    await new Promise((r) => setTimeout(r, 200));
    expect(events.filter((e) => e.path === path).length).toBe(0);

    await pad.write({ path, content: "post" });
    await new Promise((r) => setTimeout(r, 200));
    expect(events.filter((e) => e.path === path).length).toBeGreaterThanOrEqual(1);
  } finally {
    unsub();
  }
}

async function testSubscriberIsolation(factory: ScratchpadFactory): Promise<void> {
  const pad = await factory();
  const path = scratchpadPath("events/isolation");
  let goodCount = 0;
  const unsubBad = pad.onChange(() => {
    throw new Error("subscriber boom");
  });
  const unsubGood = pad.onChange(() => {
    goodCount += 1;
  });
  try {
    await pad.write({ path, content: "x" });
    await new Promise((r) => setTimeout(r, 200));
    expect(goodCount).toBeGreaterThanOrEqual(1);
  } finally {
    unsubBad();
    unsubGood();
  }
}

/**
 * Run the shared ScratchpadComponent contract suite against `factory`.
 *
 * Both `@koi/scratchpad-local` and `@koi/scratchpad-nexus` must pass this
 * suite — divergence is a contract bug, not a backend quirk.
 *
 * The suite covers behavior visible at the contract boundary: CRUD,
 * generation/CAS semantics, list filtering, and onChange notification.
 * Backend-private corners (pagination protocol, fallback wiring, transport
 * health) belong in adapter-specific tests, not here.
 */
export function describeScratchpadConformance(label: string, factory: ScratchpadFactory): void {
  describe(`ScratchpadComponent conformance: ${label}`, () => {
    test("write/read round-trip preserves content and assigns generation 1", () =>
      testWriteRead(factory));
    test("read of missing path returns NOT_FOUND, not throws", () => testReadMissing(factory));
    test("unconditional write overwrites and increments generation", () =>
      testOverwriteIncrements(factory));
    test("CAS create-only (expectedGeneration=0) fails CONFLICT when path exists", () =>
      testCasCreateOnly(factory));
    test("CAS update with stale generation fails CONFLICT", () => testCasStale(factory));
    test("delete removes the entry and is observable via list/read", () => testDelete(factory));
    test("list returns summaries (no content) for all written entries", () =>
      testListSummaries(factory));
    test("onChange eventually delivers a 'written' event reflecting the latest generation", () =>
      testOnChangeEventual(factory));
    test("onChange does NOT replay historical state to a new subscriber", () =>
      testOnChangeNoReplay(factory));
    test("a throwing subscriber must not stop sibling subscribers from receiving events", () =>
      testSubscriberIsolation(factory));
  });
}
