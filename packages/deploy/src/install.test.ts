import { describe, expect, it } from "bun:test";
import { resolveServiceName } from "./platform.js";
import { renderLaunchdPlist } from "./templates/launchd.js";
import { renderSystemdUnit } from "./templates/systemd.js";

/**
 * Install orchestration tests — verifies the end-to-end flow
 * by testing that all component pieces integrate correctly.
 *
 * Actual service manager commands (systemctl, launchctl) are not
 * invoked in tests — we test the template generation and path
 * resolution that feeds into them.
 */

describe("install orchestration", () => {
  it("resolves service name from agent name", () => {
    expect(resolveServiceName("my-cool-agent")).toBe("koi-my-cool-agent");
  });

  it("generates valid systemd unit for install", () => {
    const unit = renderSystemdUnit({
      name: "test-agent",
      bunPath: "/usr/local/bin/bun",
      koiPath: "/app/node_modules/.bin/koi",
      manifestPath: "/app/koi.yaml",
      workDir: "/app",
      port: 9100,
      restart: "on-failure",
      restartDelaySec: 5,
      system: false,
    });

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("serve");
  });

  it("generates valid launchd plist for install", () => {
    const plist = renderLaunchdPlist({
      label: "com.koi.test-agent",
      name: "test-agent",
      bunPath: "/usr/local/bin/bun",
      koiPath: "/app/node_modules/.bin/koi",
      manifestPath: "/app/koi.yaml",
      workDir: "/app",
      port: 9100,
      restartDelaySec: 5,
      logDir: "/tmp/logs",
    });

    expect(plist).toContain("<?xml");
    expect(plist).toContain("com.koi.test-agent");
    expect(plist).toContain("serve");
  });

  it("uses correct port in generated files", () => {
    const unit = renderSystemdUnit({
      name: "test",
      bunPath: "/bin/bun",
      koiPath: "/bin/koi",
      manifestPath: "/app/koi.yaml",
      workDir: "/app",
      port: 8080,
      restart: "always",
      restartDelaySec: 10,
      system: true,
    });

    expect(unit).toContain("--port 8080");
    expect(unit).toContain("http://localhost:8080/health");
  });
});
