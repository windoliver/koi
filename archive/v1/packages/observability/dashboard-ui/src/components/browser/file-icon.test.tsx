import { describe, expect, test } from "bun:test";
import { cleanup, render } from "../../__tests__/setup.js";
import { FileIcon } from "./file-icon.js";

describe("FileIcon", () => {
  test("renders for directory (closed)", () => {
    const { container } = render(<FileIcon name="agents" isDirectory={true} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeDefined();
    cleanup();
  });

  test("renders for directory (open)", () => {
    const { container } = render(<FileIcon name="agents" isDirectory={true} isOpen={true} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeDefined();
    cleanup();
  });

  test("renders for JSON file", () => {
    const { container } = render(<FileIcon name="config.json" isDirectory={false} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeDefined();
    cleanup();
  });

  test("renders for text file", () => {
    const { container } = render(<FileIcon name="readme.md" isDirectory={false} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeDefined();
    cleanup();
  });

  test("renders for unknown file type", () => {
    const { container } = render(<FileIcon name="data.bin" isDirectory={false} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeDefined();
    cleanup();
  });

  test("applies custom className", () => {
    const { container } = render(
      <FileIcon name="test.json" isDirectory={false} className="custom-class" />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("custom-class");
    cleanup();
  });
});
