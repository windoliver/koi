import { describe, expect, test } from "bun:test";
import { expandQuery } from "./expand.js";

describe("expandQuery", () => {
  test("tokenizes and lowercases input", () => {
    const terms = expandQuery("Hello World");
    expect(terms).toEqual(["hello", "world"]);
  });

  test("filters English stop words", () => {
    const terms = expandQuery("the quick brown fox is in the garden");
    expect(terms).toEqual(["quick", "brown", "fox", "garden"]);
  });

  test("filters short tokens below minTokenLength", () => {
    const terms = expandQuery("I am a big fan");
    // "i", "am", "a" are stop words; "big" and "fan" remain
    expect(terms).toEqual(["big", "fan"]);
  });

  test("deduplicates while preserving order", () => {
    const terms = expandQuery("search search engine search optimization");
    expect(terms).toEqual(["search", "engine", "optimization"]);
  });

  test("splits on non-alphanumeric characters", () => {
    const terms = expandQuery("hello-world_foo.bar");
    expect(terms).toEqual(["hello", "world", "foo", "bar"]);
  });

  test("custom stop words override default set", () => {
    const custom = new Set(["custom", "stop"]);
    const terms = expandQuery("custom stop words here", { stopWords: custom });
    // "the" is NOT filtered because we replaced the default set
    expect(terms).toEqual(["words", "here"]);
  });

  test("custom minTokenLength", () => {
    const terms = expandQuery("go do it now please", { minTokenLength: 4 });
    // "go", "do", "it", "now" are all < 4 chars
    expect(terms).toEqual(["please"]);
  });

  test("empty input returns empty array", () => {
    expect(expandQuery("")).toEqual([]);
  });

  test("all-stopword input returns empty array", () => {
    expect(expandQuery("the and or but")).toEqual([]);
  });

  test("numeric tokens are preserved", () => {
    const terms = expandQuery("version 42 release");
    expect(terms).toEqual(["version", "42", "release"]);
  });
});
