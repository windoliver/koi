import { describe, expect, test } from "bun:test";
import type { FileSystemBackend, KoiError, Result } from "@koi/core";
import { createContextNamespace } from "./context-namespace.js";

function createMockBackend(name = "mock"): FileSystemBackend & {
  readonly calls: () => readonly string[];
} {
  const calls: string[] = [];
  return {
    name,
    read: (path) => {
      calls.push(`read:${path}`);
      return { ok: true, value: { content: "", path, size: 0 } };
    },
    write: (path, content) => {
      calls.push(`write:${path}:${content}`);
      return { ok: true, value: { path, bytesWritten: content.length } };
    },
    edit: (path) => {
      calls.push(`edit:${path}`);
      return { ok: true, value: { path, hunksApplied: 1 } };
    },
    list: (path) => {
      calls.push(`list:${path}`);
      return {
        ok: true,
        value: { entries: [{ path: "/notes.md", kind: "file" }], truncated: false },
      };
    },
    search: (pattern, options) => {
      calls.push(`search:${pattern}:${options?.glob ?? ""}`);
      return {
        ok: true,
        value: { matches: [{ path: "/notes.md", line: 1, text: pattern }], truncated: false },
      };
    },
    delete: (path) => {
      calls.push(`delete:${path}`);
      return { ok: true, value: { path } };
    },
    rename: (from, to) => {
      calls.push(`rename:${from}:${to}`);
      return { ok: true, value: { from, to } };
    },
    calls: () => calls,
  };
}

function isErr(
  result: Result<unknown, KoiError>,
): result is { readonly ok: false; readonly error: KoiError } {
  return !result.ok;
}

describe("createContextNamespace", () => {
  test("mounts, lists, and unmounts namespace backends", () => {
    const ns = createContextNamespace();
    const backend = createMockBackend();

    ns.mount({ path: "/shared/", backend, mode: "rw", metadata: { grant: "team" } });

    expect(ns.list()).toEqual([
      { path: "/shared", backend, mode: "rw", metadata: { grant: "team" } },
    ]);
    expect(ns.unmount("/shared/")).toBe(true);
    expect(ns.list()).toEqual([]);
    expect(ns.unmount("/shared")).toBe(false);
  });

  test("rejects invalid access modes at runtime", () => {
    const ns = createContextNamespace();
    const backend = createMockBackend();

    expect(() =>
      ns.mount({
        path: "/shared",
        backend,
        mode: "write" as unknown as "rw",
      }),
    ).toThrow(/access mode/);
    expect(ns.list()).toEqual([]);
  });

  test("resolves the longest matching namespace prefix", async () => {
    const ns = createContextNamespace();
    const shared = createMockBackend("shared");
    const project = createMockBackend("project");
    ns.mount({ path: "/shared", backend: shared, mode: "rw" });
    ns.mount({ path: "/shared/project", backend: project, mode: "rw" });

    const resolved = await ns.resolve("/shared/project/notes.md");

    expect(resolved?.name).toBe("context-namespace(project:/shared/project)");
    resolved?.read("/shared/project/notes.md");
    expect(project.calls()).toContain("read:/notes.md");
    expect(shared.calls()).toEqual([]);
  });

  test("resolved read-only backend blocks write operations", async () => {
    const ns = createContextNamespace();
    const backend = createMockBackend();
    ns.mount({ path: "/shared", backend, mode: "ro" });

    const resolved = await ns.resolve("/shared/notes.md");
    const result = resolved?.write("/shared/notes.md", "nope") as Result<unknown, KoiError>;

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("read-only");
    }
    expect(backend.calls()).toEqual([]);
  });

  test("resolved read-write backend permits writes under the mount", async () => {
    const ns = createContextNamespace();
    const backend = createMockBackend();
    ns.mount({ path: "/shared", backend, mode: "rw" });

    const resolved = await ns.resolve("/shared/notes.md");
    const result = resolved?.write("/shared/notes.md", "ok");

    expect(result).toHaveProperty("ok", true);
    expect(backend.calls()).toContain("write:/notes.md:ok");
  });

  test("resolved backend returns namespace paths in path-bearing results", async () => {
    const ns = createContextNamespace();
    const backend = createMockBackend();
    ns.mount({ path: "/shared", backend, mode: "rw" });

    const resolved = await ns.resolve("/shared/notes.md");
    const read = await resolved?.read("/shared/notes.md");
    const write = await resolved?.write("/shared/notes.md", "ok");
    const edit = await resolved?.edit("/shared/notes.md", []);
    const list = await resolved?.list("/shared");
    const del = await resolved?.delete?.("/shared/notes.md");
    const rename = await resolved?.rename?.("/shared/old.md", "/shared/new.md");

    expect(read).toHaveProperty("value.path", "/shared/notes.md");
    expect(write).toHaveProperty("value.path", "/shared/notes.md");
    expect(edit).toHaveProperty("value.path", "/shared/notes.md");
    expect(list).toHaveProperty("value.entries.0.path", "/shared/notes.md");
    expect(del).toHaveProperty("value.path", "/shared/notes.md");
    expect(rename).toHaveProperty("value", { from: "/shared/old.md", to: "/shared/new.md" });
  });

  test("resolved search maps globs into the mount and returns namespace paths", async () => {
    const ns = createContextNamespace();
    const backend = createMockBackend();
    ns.mount({ path: "/shared", backend, mode: "ro" });

    const resolved = await ns.resolve("/shared/notes.md");
    const result = await resolved?.search("needle", { glob: "/shared/docs/*" });

    expect(result).toHaveProperty("ok", true);
    if (result === undefined || !result.ok) return;
    expect(result.value.matches).toEqual([{ path: "/shared/notes.md", line: 1, text: "needle" }]);
    expect(backend.calls()).toContain("search:needle:docs/*");
  });

  test("resolved search treats relative globs as mount-relative", async () => {
    const ns = createContextNamespace();
    const backend = createMockBackend();
    ns.mount({ path: "/shared", backend, mode: "ro" });

    const resolved = await ns.resolve("/shared/notes.md");
    const result = await resolved?.search("needle", { glob: "docs/*" });

    expect(result).toHaveProperty("ok", true);
    expect(backend.calls()).toContain("search:needle:docs/*");
  });

  test("resolved search rejects globs outside the mount", async () => {
    const ns = createContextNamespace();
    const backend = createMockBackend();
    ns.mount({ path: "/shared", backend, mode: "ro" });

    const resolved = await ns.resolve("/shared/notes.md");
    const result = await resolved?.search("needle", { glob: "/private/*" });

    expect(result).toHaveProperty("ok", false);
    if (result === undefined || result.ok) return;
    expect(result.error.code).toBe("PERMISSION");
    expect(backend.calls()).toEqual([]);
  });

  test("watch emits mounted, resolved, and unmounted events", () => {
    const ns = createContextNamespace();
    const backend = createMockBackend();
    const events: string[] = [];
    const unsubscribe = ns.watch?.((event) => {
      events.push(event.kind);
    });

    ns.mount({ path: "/shared", backend, mode: "rw" });
    ns.resolve("/shared/a.txt");
    ns.unmount("/shared");
    unsubscribe?.();
    ns.mount({ path: "/after-unsubscribe", backend, mode: "rw" });

    expect(events).toEqual(["mounted", "resolved", "unmounted"]);
  });

  test("one shared namespace instance gives parent and child the same /shared visibility", async () => {
    const parentNamespace = createContextNamespace();
    const childNamespace = parentNamespace;
    const backend = createMockBackend();

    parentNamespace.mount({ path: "/shared", backend, mode: "rw" });

    const childResolved = await childNamespace.resolve("/shared/child.txt");
    childResolved?.write("/shared/child.txt", "hello");

    expect(backend.calls()).toContain("write:/child.txt:hello");
  });
});
