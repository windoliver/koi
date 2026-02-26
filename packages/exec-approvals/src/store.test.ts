import { describe, expect, test } from "bun:test";
import { createInMemoryRulesStore } from "./store.js";

describe("createInMemoryRulesStore", () => {
  test("load() returns empty rules initially", async () => {
    const store = createInMemoryRulesStore();
    const rules = await store.load();
    expect(rules.allow).toEqual([]);
    expect(rules.deny).toEqual([]);
  });

  test("save() then load() returns saved rules", async () => {
    const store = createInMemoryRulesStore();
    await store.save({ allow: ["bash:ls"], deny: ["bash:rm*"] });
    const rules = await store.load();
    expect(rules.allow).toEqual(["bash:ls"]);
    expect(rules.deny).toEqual(["bash:rm*"]);
  });

  test("multiple saves overwrite (not append)", async () => {
    const store = createInMemoryRulesStore();
    await store.save({ allow: ["bash:ls"], deny: [] });
    await store.save({ allow: ["bash:cat"], deny: ["bash:rm"] });
    const rules = await store.load();
    expect(rules.allow).toEqual(["bash:cat"]);
    expect(rules.deny).toEqual(["bash:rm"]);
  });

  test("load() returns a fresh copy — mutating returned array does not affect store", async () => {
    const store = createInMemoryRulesStore();
    await store.save({ allow: ["bash:ls"], deny: [] });
    const rules = await store.load();
    // Mutate the returned array
    (rules.allow as string[]).push("bash:evil");
    // Load again — store should be unaffected
    const rules2 = await store.load();
    expect(rules2.allow).toEqual(["bash:ls"]);
  });

  test("save() with empty arrays clears rules", async () => {
    const store = createInMemoryRulesStore();
    await store.save({ allow: ["bash:ls"], deny: ["bash:rm"] });
    await store.save({ allow: [], deny: [] });
    const rules = await store.load();
    expect(rules.allow).toEqual([]);
    expect(rules.deny).toEqual([]);
  });

  test("multiple stores are independent", async () => {
    const store1 = createInMemoryRulesStore();
    const store2 = createInMemoryRulesStore();
    await store1.save({ allow: ["bash:ls"], deny: [] });
    const r2 = await store2.load();
    expect(r2.allow).toEqual([]);
  });
});
