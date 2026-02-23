import { describe, expect, it } from "bun:test";
import {
  detectBunPath,
  detectPlatform,
  resolveLaunchdLabel,
  resolveLogDir,
  resolveServiceDir,
  resolveServiceName,
} from "./platform.js";

describe("detectPlatform", () => {
  it("returns linux or darwin on supported platforms", () => {
    const platform = detectPlatform();
    expect(["linux", "darwin"]).toContain(platform);
  });
});

describe("detectBunPath", () => {
  it("returns a non-empty string", () => {
    const path = detectBunPath();
    expect(path.length).toBeGreaterThan(0);
  });
});

describe("resolveServiceName", () => {
  it("prefixes with koi-", () => {
    expect(resolveServiceName("my-agent")).toBe("koi-my-agent");
  });

  it("lowercases the name", () => {
    expect(resolveServiceName("MyAgent")).toBe("koi-myagent");
  });

  it("replaces special characters with hyphens", () => {
    expect(resolveServiceName("my agent!")).toBe("koi-my-agent");
  });

  it("collapses multiple hyphens", () => {
    expect(resolveServiceName("my--agent")).toBe("koi-my-agent");
  });

  it("strips leading/trailing hyphens from sanitized part", () => {
    expect(resolveServiceName("-agent-")).toBe("koi-agent");
  });
});

describe("resolveLaunchdLabel", () => {
  it("prefixes with com.koi.", () => {
    expect(resolveLaunchdLabel("my-agent")).toBe("com.koi.my-agent");
  });

  it("lowercases the name", () => {
    expect(resolveLaunchdLabel("MyAgent")).toBe("com.koi.myagent");
  });
});

describe("resolveServiceDir", () => {
  it("returns system dir for linux system", () => {
    expect(resolveServiceDir("linux", true)).toBe("/etc/systemd/system");
  });

  it("returns user dir for linux user", () => {
    const dir = resolveServiceDir("linux", false);
    expect(dir).toContain(".config/systemd/user");
  });

  it("returns system dir for darwin system", () => {
    expect(resolveServiceDir("darwin", true)).toBe("/Library/LaunchDaemons");
  });

  it("returns user dir for darwin user", () => {
    const dir = resolveServiceDir("darwin", false);
    expect(dir).toContain("Library/LaunchAgents");
  });
});

describe("resolveLogDir", () => {
  it("returns log path for linux with service name", () => {
    const dir = resolveLogDir("linux", "koi-test");
    expect(dir).toContain(".local/share/koi/logs/koi-test");
  });

  it("returns log path for darwin with service name", () => {
    const dir = resolveLogDir("darwin", "koi-test");
    expect(dir).toContain("Library/Logs/Koi/koi-test");
  });
});
