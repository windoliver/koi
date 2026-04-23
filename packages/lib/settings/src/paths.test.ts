import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

  test("uses process.cwd() when cwd not provided", () => {
    const paths = resolveSettingsPaths({ homeDir: "/home/user" });
    expect(paths.project).toBe(join(process.cwd(), ".koi", "settings.json"));
  });
});
