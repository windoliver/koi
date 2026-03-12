import { describe, expect, test } from "bun:test";
import { render } from "../../__tests__/setup.js";
import { SnapshotDag } from "./snapshot-dag.js";

// React Flow requires ResizeObserver and SVG globals not present in happy-dom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (typeof globalThis.SVGElement === "undefined") {
  // @ts-expect-error — minimal stub for React Flow in test environment
  globalThis.SVGElement = class SVGElement extends (globalThis.HTMLElement ?? class {}) {};
}

if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
  // @ts-expect-error — minimal stub for React Flow transforms
  globalThis.DOMMatrixReadOnly = class DOMMatrixReadOnly {
    readonly a: number = 1;
    readonly b: number = 0;
    readonly c: number = 0;
    readonly d: number = 1;
    readonly e: number = 0;
    readonly f: number = 0;
  };
}

describe("SnapshotDag", () => {
  test("renders empty state for no snapshots", () => {
    const { getByText } = render(<SnapshotDag nodes={[]} />);
    expect(getByText("No snapshots")).toBeDefined();
  });

  test("renders without crashing with sample nodes", () => {
    const nodes = [
      { hash: "abc12345def", parentHash: undefined, timestamp: 1700000000000 },
      { hash: "def67890abc", parentHash: "abc12345def", timestamp: 1700001000000 },
    ] as const;

    // React Flow relies on many browser APIs that happy-dom doesn't support.
    // Verify that the component at least mounts without a fatal error.
    const { container } = render(<SnapshotDag nodes={nodes} />);
    expect(container).toBeDefined();
  });
});
