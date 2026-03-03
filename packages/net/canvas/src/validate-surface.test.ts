import { describe, expect, test } from "bun:test";
import type { A2uiComponent } from "./types.js";
import { componentId } from "./types.js";
import { validateSurfaceComponents } from "./validate-surface.js";

function makeComponent(id: string, children?: readonly string[]): A2uiComponent {
  const base = { id: componentId(id), type: "Text" as const };
  if (children === undefined) return base;
  return { ...base, children: children.map(componentId) };
}

describe("validateSurfaceComponents", () => {
  test("accepts a valid flat component list", () => {
    const result = validateSurfaceComponents([makeComponent("a"), makeComponent("b")]);
    expect(result.ok).toBe(true);
  });

  test("accepts a valid tree with parent-child relationships", () => {
    const result = validateSurfaceComponents([
      makeComponent("root", ["child1", "child2"]),
      makeComponent("child1"),
      makeComponent("child2"),
    ]);
    expect(result.ok).toBe(true);
  });

  test("accepts an empty component list", () => {
    const result = validateSurfaceComponents([]);
    expect(result.ok).toBe(true);
  });

  test("rejects duplicate component IDs", () => {
    const result = validateSurfaceComponents([makeComponent("a"), makeComponent("a")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Duplicate");
    }
  });

  test("rejects dangling child references", () => {
    const result = validateSurfaceComponents([makeComponent("root", ["nonexistent"])]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Dangling");
    }
  });

  test("rejects cycles: self-referencing", () => {
    const result = validateSurfaceComponents([makeComponent("a", ["a"])]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Cycle");
    }
  });

  test("rejects cycles: mutual references", () => {
    const result = validateSurfaceComponents([
      makeComponent("a", ["b"]),
      makeComponent("b", ["a"]),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Cycle");
    }
  });

  test("rejects cycles: transitive (a -> b -> c -> a)", () => {
    const result = validateSurfaceComponents([
      makeComponent("a", ["b"]),
      makeComponent("b", ["c"]),
      makeComponent("c", ["a"]),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Cycle");
    }
  });

  test("rejects when component count exceeds limit", () => {
    const components = Array.from({ length: 5 }, (_, i) => makeComponent(`comp-${i}`));
    const result = validateSurfaceComponents(components, { maxComponents: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds maximum");
    }
  });

  test("respects custom maxComponents config", () => {
    const components = Array.from({ length: 3 }, (_, i) => makeComponent(`comp-${i}`));
    const result = validateSurfaceComponents(components, { maxComponents: 10 });
    expect(result.ok).toBe(true);
  });

  test("rejects tree exceeding max depth", () => {
    // Create a chain: a -> b -> c -> d (depth 4)
    const result = validateSurfaceComponents(
      [
        makeComponent("a", ["b"]),
        makeComponent("b", ["c"]),
        makeComponent("c", ["d"]),
        makeComponent("d"),
      ],
      { maxTreeDepth: 2 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Cycle");
    }
  });

  test("accepts deep tree within max depth", () => {
    const result = validateSurfaceComponents(
      [makeComponent("a", ["b"]), makeComponent("b", ["c"]), makeComponent("c")],
      { maxTreeDepth: 10 },
    );
    expect(result.ok).toBe(true);
  });

  test("handles components with no children", () => {
    const comp: A2uiComponent = {
      id: componentId("leaf"),
      type: "Button",
    };
    const result = validateSurfaceComponents([comp]);
    expect(result.ok).toBe(true);
  });

  test("validates complex tree structure", () => {
    const result = validateSurfaceComponents([
      makeComponent("root", ["row1", "row2"]),
      makeComponent("row1", ["text1", "btn1"]),
      makeComponent("row2", ["text2"]),
      makeComponent("text1"),
      makeComponent("btn1"),
      makeComponent("text2"),
    ]);
    expect(result.ok).toBe(true);
  });
});
