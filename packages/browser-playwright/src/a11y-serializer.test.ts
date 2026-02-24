import { describe, expect, it } from "bun:test";
import { type A11yNode, serializeA11yTree } from "./a11y-serializer.js";

describe("serializeA11yTree", () => {
  describe("basic structure", () => {
    it("serializes a simple root with no children", () => {
      const node: A11yNode = { role: "WebArea", name: "My Page" };
      const result = serializeA11yTree(node);
      expect(result.text).toBe('WebArea "My Page"');
      expect(result.refs).toEqual({});
      expect(result.truncated).toBe(false);
    });

    it("omits quotes when name is empty string", () => {
      const node: A11yNode = { role: "WebArea", name: "" };
      const result = serializeA11yTree(node);
      expect(result.text).toBe("WebArea");
      expect(result.text).not.toContain('""');
    });

    it("indents children by 2 spaces per depth level", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Root",
        children: [
          {
            role: "group",
            name: "Nav",
            children: [{ role: "link", name: "Home" }],
          },
        ],
      };
      const result = serializeA11yTree(node);
      const lines = result.text.split("\n");
      expect(lines[0]).toMatch(/^WebArea/);
      expect(lines[1]).toMatch(/^ {2}group/);
      expect(lines[2]).toMatch(/^ {4}link/);
    });
  });

  describe("interactive element refs", () => {
    it("marks interactive elements with [ref=eN]", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Test",
        children: [
          { role: "button", name: "Submit" },
          { role: "link", name: "Home" },
          { role: "textbox", name: "Email" },
        ],
      };
      const result = serializeA11yTree(node);
      expect(result.text).toContain("[ref=e1]");
      expect(result.text).toContain("[ref=e2]");
      expect(result.text).toContain("[ref=e3]");
    });

    it("populates refs map with role and name", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Test",
        children: [
          { role: "button", name: "Submit" },
          { role: "link", name: "Home" },
        ],
      };
      const result = serializeA11yTree(node);
      expect(result.refs).toEqual({
        e1: { role: "button", name: "Submit" },
        e2: { role: "link", name: "Home" },
      });
    });

    it("omits name from refs entry when node name is empty", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Test",
        children: [{ role: "button", name: "" }],
      };
      const result = serializeA11yTree(node);
      expect(result.refs.e1).toEqual({ role: "button" });
      expect(result.refs.e1).not.toHaveProperty("name");
    });

    it("does not mark non-interactive elements", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Test",
        children: [
          { role: "heading", name: "Title", level: 1 },
          { role: "paragraph", name: "Some text" },
          { role: "img", name: "Logo" },
          { role: "text", name: "Body" },
        ],
      };
      const result = serializeA11yTree(node);
      expect(result.text).not.toContain("[ref=");
      expect(result.refs).toEqual({});
    });

    it("assigns refs sequentially across the full tree", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Root",
        children: [
          { role: "button", name: "First" },
          {
            role: "group",
            name: "Nav",
            children: [{ role: "link", name: "Second" }],
          },
          { role: "textbox", name: "Third" },
        ],
      };
      const result = serializeA11yTree(node);
      expect(Object.keys(result.refs)).toEqual(["e1", "e2", "e3"]);
      expect(result.refs.e1).toEqual({ role: "button", name: "First" });
      expect(result.refs.e2).toEqual({ role: "link", name: "Second" });
      expect(result.refs.e3).toEqual({ role: "textbox", name: "Third" });
    });
  });

  describe("state attributes", () => {
    it("includes level for headings", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Root",
        children: [{ role: "heading", name: "Title", level: 2 }],
      };
      const result = serializeA11yTree(node);
      expect(result.text).toContain("level=2");
    });

    it("includes checked state for checkboxes", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Form",
        children: [
          { role: "checkbox", name: "Subscribe", checked: true },
          { role: "checkbox", name: "Terms", checked: false },
          { role: "checkbox", name: "Optional", checked: "mixed" },
        ],
      };
      const result = serializeA11yTree(node);
      expect(result.text).toContain("checked");
      expect(result.text).toContain("indeterminate");
      // unchecked: no extra attribute
      const lines = result.text.split("\n");
      const termsLine = lines.find((l) => l.includes('"Terms"'));
      expect(termsLine).toBeDefined();
      expect(termsLine).not.toContain("checked");
    });

    it("includes required, disabled, selected states", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Form",
        children: [
          { role: "textbox", name: "Name", required: true },
          { role: "textbox", name: "Bio", disabled: true },
          { role: "option", name: "Item", selected: true },
        ],
      };
      const result = serializeA11yTree(node);
      expect(result.text).toContain("required");
      expect(result.text).toContain("disabled");
      expect(result.text).toContain("selected");
    });

    it("includes expanded/collapsed state", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Root",
        children: [
          { role: "combobox", name: "Open", expanded: true },
          { role: "combobox", name: "Closed", expanded: false },
        ],
      };
      const result = serializeA11yTree(node);
      expect(result.text).toContain("expanded");
      expect(result.text).toContain("collapsed");
    });

    it("includes value attribute", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Form",
        children: [{ role: "textbox", name: "Search", value: "hello world" }],
      };
      const result = serializeA11yTree(node);
      expect(result.text).toContain('value="hello world"');
    });
  });

  describe("truncation", () => {
    it("respects maxDepth and sets truncated=true", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Root",
        children: [
          {
            role: "group",
            name: "A",
            children: [
              {
                role: "group",
                name: "B",
                children: [{ role: "button", name: "Deep" }],
              },
            ],
          },
        ],
      };
      const result = serializeA11yTree(node, { maxDepth: 1 });
      expect(result.truncated).toBe(true);
      expect(result.text).not.toContain("Deep");
      expect(result.text).toContain("Root");
    });

    it("respects maxTokens and sets truncated=true", () => {
      const children: A11yNode[] = Array.from({ length: 100 }, (_, i) => ({
        role: "button",
        name: `Button number ${i} with a longish name`,
      }));
      const node: A11yNode = { role: "WebArea", name: "Test", children };
      const result = serializeA11yTree(node, { maxTokens: 30 });
      expect(result.truncated).toBe(true);
      expect(Object.keys(result.refs).length).toBeGreaterThan(0);
      expect(Object.keys(result.refs).length).toBeLessThan(100);
    });

    it("does not truncate within the default limits", () => {
      const node: A11yNode = {
        role: "WebArea",
        name: "Simple Page",
        children: [
          { role: "heading", name: "Welcome", level: 1 },
          { role: "button", name: "Go" },
          { role: "link", name: "Back" },
        ],
      };
      const result = serializeA11yTree(node);
      expect(result.truncated).toBe(false);
    });

    it("uses default maxTokens=4000 and maxDepth=8", () => {
      const node: A11yNode = { role: "WebArea", name: "Test" };
      const result = serializeA11yTree(node);
      expect(result.truncated).toBe(false);
    });
  });
});
