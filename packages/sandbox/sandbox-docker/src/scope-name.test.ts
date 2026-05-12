import { describe, expect, test } from "bun:test";
import { deriveScopeContainerName } from "./scope-name.js";

describe("deriveScopeContainerName", () => {
  test("is deterministic for the same scope", () => {
    const a = deriveScopeContainerName("project-foo");
    const b = deriveScopeContainerName("project-foo");
    expect(a).toBe(b);
  });

  test("produces a Docker-valid container name", () => {
    const name = deriveScopeContainerName("Project Foo / bar");
    // Docker container name regex: ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,253}$
    expect(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,253}$/.test(name)).toBe(true);
  });

  test("distinguishes scopes that sanitize to the same slug", () => {
    // Both slugs collapse to "ab-cd" but the hash suffix must keep them distinct
    // so two different logical scopes do not collide on the same container name.
    const a = deriveScopeContainerName("ab cd");
    const b = deriveScopeContainerName("ab/cd");
    expect(a).not.toBe(b);
  });

  test("handles scope of all special chars by falling back to a safe slug", () => {
    const name = deriveScopeContainerName("///###");
    expect(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,253}$/.test(name)).toBe(true);
    expect(name.startsWith("koi-sb-")).toBe(true);
  });

  test("starts with the koi-sb- namespace prefix", () => {
    expect(deriveScopeContainerName("anything").startsWith("koi-sb-")).toBe(true);
  });
});
