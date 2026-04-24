import { describe, expect, test } from "bun:test";
import { resolveSettingsPaths } from "./paths.js";

describe("resolveSettingsPaths", () => {
  const opts = {
    cwd: "/project",
    homeDir: "/home/user",
    flagPath: "/custom/settings.json",
  };

  test("user layer resolves to ~/.koi/settings.json", () => {
    const paths = resolveSettingsPaths(opts);
    expect(paths.user).toBe("/home/user/.koi/settings.json");
  });

  test("project layer resolves to <cwd>/.koi/settings.json", () => {
    const paths = resolveSettingsPaths(opts);
    expect(paths.project).toBe("/project/.koi/settings.json");
  });

  test("local layer resolves to <cwd>/.koi/settings.local.json", () => {
    const paths = resolveSettingsPaths(opts);
    expect(paths.local).toBe("/project/.koi/settings.local.json");
  });

  test("flag layer resolves to provided flagPath", () => {
    const paths = resolveSettingsPaths(opts);
    expect(paths.flag).toBe("/custom/settings.json");
  });

  test("flag layer is null when no flagPath provided", () => {
    const paths = resolveSettingsPaths({ cwd: "/project", homeDir: "/home/user" });
    expect(paths.flag).toBeNull();
  });

  test("policy layer resolves to platform path", () => {
    const paths = resolveSettingsPaths(opts);
    expect(typeof paths.policy).toBe("string");
    expect(paths.policy).toMatch(/policy\.json$/);
  });

  test("cwd='/' does not infinite-loop and returns a valid project path", () => {
    const paths = resolveSettingsPaths({ cwd: "/", homeDir: "/home/user" });
    // Falls back to "/" as project root — no hang, valid string
    expect(typeof paths.project).toBe("string");
    expect(paths.project).toMatch(/settings\.json$/);
  });

  test("uses process.cwd() (walked to project root) when cwd not provided", () => {
    const paths = resolveSettingsPaths({ homeDir: "/home/user" });
    // findProjectRoot walks up from process.cwd() to the nearest git root,
    // so the resolved path ends with .koi/settings.json but may differ from
    // process.cwd() when the test runs inside a monorepo subdirectory.
    expect(paths.project).toMatch(/\.koi[/\\]settings\.json$/);
  });
});
