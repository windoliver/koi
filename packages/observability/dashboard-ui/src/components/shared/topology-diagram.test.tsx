import { describe, expect, test } from "bun:test";
import { render, screen } from "../../__tests__/setup.js";
import { TopologyDiagram } from "./topology-diagram.js";

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

describe("TopologyDiagram", () => {
  test("renders empty state for no connections", () => {
    render(<TopologyDiagram connections={[]} />);
    expect(screen.getByText("No connections")).toBeDefined();
  });

  test("renders without crashing with sample connections", () => {
    const connections = [
      { channelId: "ch-1", channelType: "cli", agentId: "agent-a", connected: true },
      { channelId: "ch-2", channelType: "web", agentId: "agent-b", connected: false },
    ] as const;

    // React Flow relies on many browser APIs that happy-dom doesn't support.
    // Verify that the component at least mounts without a fatal error.
    const { container } = render(<TopologyDiagram connections={connections} />);
    expect(container).toBeDefined();
  });
});
