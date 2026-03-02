import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  test("returns empty metadata when no frontmatter present", () => {
    const result = parseFrontmatter("Hello world\n\nSome content.");
    expect(result.metadata).toEqual({});
    expect(result.body).toBe("Hello world\n\nSome content.");
  });

  test("parses standard key-value pairs", () => {
    const content = `---
title: My Document
author: Jane Doe
---
Body text here.`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({
      title: "My Document",
      author: "Jane Doe",
    });
    expect(result.body).toBe("Body text here.");
  });

  test("parses inline tag list [a, b, c]", () => {
    const content = `---
tags: [api, auth, security]
---
Content.`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({ tags: ["api", "auth", "security"] });
  });

  test("parses multi-line tag list", () => {
    const content = `---
tags:
  - architecture
  - design
  - patterns
---
Content.`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({
      tags: ["architecture", "design", "patterns"],
    });
  });

  test("strips # prefix from tags", () => {
    const content = `---
tags: [#api, #auth]
---
Body.`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({ tags: ["api", "auth"] });
  });

  test("strips # prefix from multi-line tags", () => {
    const content = `---
tags:
  - #api
  - #auth
---
Body.`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({ tags: ["api", "auth"] });
  });

  test("handles empty frontmatter block", () => {
    const content = `---
---
Body content.`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({});
    expect(result.body).toBe("Body content.");
  });

  test("does not confuse --- in body with frontmatter delimiter", () => {
    const content = `---
title: Doc
---
Some text.

---

More text after horizontal rule.`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({ title: "Doc" });
    expect(result.body).toContain("---");
    expect(result.body).toContain("More text after horizontal rule.");
  });

  test("parses boolean and number values", () => {
    const content = `---
draft: true
published: false
version: 42
weight: 3.14
---
Body.`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({
      draft: true,
      published: false,
      version: 42,
      weight: 3.14,
    });
  });

  test("parses quoted strings", () => {
    const content = `---
title: "Hello: World"
subtitle: 'Another: Value'
---
Body.`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({
      title: "Hello: World",
      subtitle: "Another: Value",
    });
  });

  test("returns empty metadata for malformed YAML (no throw)", () => {
    const content = `---
: bad key
---
Body.`;
    const result = parseFrontmatter(content);
    // Should not throw, malformed key is skipped
    expect(result.body).toBe("Body.");
  });

  test("handles empty file", () => {
    const result = parseFrontmatter("");
    expect(result.metadata).toEqual({});
    expect(result.body).toBe("");
  });

  test("handles file with only frontmatter, no body", () => {
    const content = `---
title: Metadata Only
---
`;
    const result = parseFrontmatter(content);
    expect(result.metadata).toEqual({ title: "Metadata Only" });
    expect(result.body).toBe("");
  });
});
