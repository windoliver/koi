import { describe, expect, test } from "bun:test";
import { InMemoryThreadStore, type ThreadState } from "./thread-store.js";

const state = (chain: readonly string[]): ThreadState => ({ chain });

describe("InMemoryThreadStore", () => {
  test("get returns null for unknown thread", async () => {
    const s = new InMemoryThreadStore();
    expect(await s.get("t1")).toBeNull();
  });

  test("first cas with version 0 succeeds", async () => {
    const s = new InMemoryThreadStore();
    expect(await s.cas("t1", 0, state(["m1"]))).toBe(true);
    const r = await s.get("t1");
    expect(r?.version).toBe(1);
    expect(r?.state.chain).toEqual(["m1"]);
  });

  test("cas with stale version fails", async () => {
    const s = new InMemoryThreadStore();
    await s.cas("t1", 0, state(["m1"]));
    expect(await s.cas("t1", 0, state(["m2"]))).toBe(false);
  });

  test("read-modify-write loop wins after retry", async () => {
    const s = new InMemoryThreadStore();
    await s.cas("t1", 0, state(["m1"]));
    const cur = await s.get("t1");
    if (!cur) throw new Error();
    expect(await s.cas("t1", cur.version, state([...cur.state.chain, "m2"]))).toBe(true);
  });
});
