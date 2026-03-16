import { describe, expect, test } from "bun:test";
import { createInitialNexusBrowser } from "../state/domain-types.js";
import { NexusBrowserView } from "./nexus-browser-view.js";

describe("NexusBrowserView", () => {
  test("is a function component", () => {
    expect(typeof NexusBrowserView).toBe("function");
  });

  test("accepts NexusBrowserState props", () => {
    const props = {
      nexusBrowser: createInitialNexusBrowser(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.nexusBrowser.entries).toEqual([]);
    expect(props.nexusBrowser.path).toBe("/");
    expect(props.nexusBrowser.selectedIndex).toBe(0);
    expect(props.nexusBrowser.fileContent).toBe(null);
    expect(props.nexusBrowser.loading).toBe(false);
  });

  test("initial state has empty entries", () => {
    const state = createInitialNexusBrowser();
    expect(state.entries).toHaveLength(0);
  });
});
