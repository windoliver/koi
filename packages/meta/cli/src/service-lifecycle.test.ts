import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  resolveServiceConfig,
  type ServiceConfig,
} from "./service-lifecycle.js";

describe("service lifecycle", () => {
  test("resolves service settings from manifest deploy block with flag overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koi-service-"));
    const prevState = process.env.KOI_STATE_DIR;
    const prevLog = process.env.KOI_LOG_DIR;
    process.env.KOI_STATE_DIR = join(dir, "state");
    process.env.KOI_LOG_DIR = join(dir, "logs-root");
    try {
      const manifest = join(dir, "koi.yaml");
      await writeFile(
        manifest,
        [
          "name: Review Agent",
          "model:",
          "  name: openai:gpt-test",
          "deploy:",
          "  port: 9100",
          "  restart: always",
          "  restartDelaySec: 7",
          "  envFile: .env.service",
          "  logDir: ./logs/service",
          "  system: false",
        ].join("\n"),
      );

      const resolved = await resolveServiceConfig({
        manifest,
        port: 9200,
        system: true,
        validateManifest: true,
        cwd: dir,
      });

      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.error);
      expect(resolved.value.agentName).toBe("Review Agent");
      expect(resolved.value.serviceName).toBe("koi-review-agent");
      expect(resolved.value.port).toBe(9200);
      expect(resolved.value.system).toBe(true);
      expect(resolved.value.restart).toBe("always");
      expect(resolved.value.restartDelaySec).toBe(7);
      expect(resolved.value.envFile).toBe(join(dir, ".env.service"));
      expect(resolved.value.logDir).toBe(join(dir, "logs", "service"));
      expect(resolved.value.lockFilePath).toBe(
        join(dir, "state", "services", "koi-review-agent", "gateway-http.lock"),
      );
    } finally {
      if (prevState === undefined) delete process.env.KOI_STATE_DIR;
      else process.env.KOI_STATE_DIR = prevState;
      if (prevLog === undefined) delete process.env.KOI_LOG_DIR;
      else process.env.KOI_LOG_DIR = prevLog;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("generates service files that execute koi serve and append logs", () => {
    const config: ServiceConfig = {
      platform: "linux",
      agentName: "Review Agent",
      serviceName: "koi-review-agent",
      launchdLabel: "com.koi.review-agent",
      manifestPath: "/repo/koi.yaml",
      workDir: "/repo",
      port: 9100,
      system: false,
      restart: "on-failure",
      restartDelaySec: 5,
      envFile: undefined,
      logDir: "/tmp/koi-logs",
      logPath: "/tmp/koi-logs/service.log",
      stateDir: "/tmp/koi-state",
      serviceStatePath: "/tmp/koi-state/service-state.json",
      lockFilePath: "/tmp/koi-state/gateway-http.lock",
      serviceFilePath: "/tmp/koi.service",
    };

    const unit = generateSystemdUnit(config);
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("serve --manifest /repo/koi.yaml --port 9100");
    expect(unit).toContain("StandardOutput=append:/tmp/koi-logs/service.log");

    const plist = generateLaunchdPlist({ ...config, platform: "darwin" }, [
      "/usr/local/bin/koi",
      "serve",
      "--manifest",
      "/repo/koi.yaml",
    ]);
    expect(plist).toContain("<string>com.koi.review-agent</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>/tmp/koi-logs/service.log</string>");
  });

  test("prefers installed state for service inspection commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koi-service-state-"));
    const prevState = process.env.KOI_STATE_DIR;
    process.env.KOI_STATE_DIR = join(dir, "state");
    try {
      const manifest = join(dir, "koi.yaml");
      await writeFile(
        manifest,
        [
          "name: State Agent",
          "model:",
          "  name: openai:gpt-test",
          "deploy:",
          "  system: false",
        ].join("\n"),
      );

      const initial = await resolveServiceConfig({
        manifest,
        port: 9200,
        system: true,
        cwd: dir,
      });
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw new Error(initial.error);
      await mkdir(initial.value.stateDir, { recursive: true });
      await writeFile(
        initial.value.serviceStatePath,
        JSON.stringify({ version: 1, system: true, port: 9200, logDir: join(dir, "logs") }),
      );

      const inspected = await resolveServiceConfig({
        manifest,
        port: undefined,
        system: undefined,
        installedState: "prefer",
        cwd: dir,
      });
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) throw new Error(inspected.error);
      expect(inspected.value.system).toBe(true);
      expect(inspected.value.port).toBe(9200);
      expect(inspected.value.logDir).toBe(join(dir, "logs"));
    } finally {
      if (prevState === undefined) delete process.env.KOI_STATE_DIR;
      else process.env.KOI_STATE_DIR = prevState;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("maps launchd restart modes", () => {
    const base: ServiceConfig = {
      platform: "darwin",
      agentName: "Review Agent",
      serviceName: "koi-review-agent",
      launchdLabel: "com.koi.review-agent",
      manifestPath: "/repo/koi.yaml",
      workDir: "/repo",
      port: 9100,
      system: false,
      restart: "no",
      restartDelaySec: 5,
      envFile: undefined,
      logDir: "/tmp/koi-logs",
      logPath: "/tmp/koi-logs/service.log",
      stateDir: "/tmp/koi-state",
      serviceStatePath: "/tmp/koi-state/service-state.json",
      lockFilePath: "/tmp/koi-state/gateway-http.lock",
      serviceFilePath: "/tmp/koi.plist",
    };
    expect(generateLaunchdPlist(base, ["koi", "serve"])).not.toContain("<key>KeepAlive</key>");
    expect(generateLaunchdPlist({ ...base, restart: "always" }, ["koi", "serve"])).toContain(
      "<key>KeepAlive</key>\n  <true/>",
    );
    expect(generateLaunchdPlist({ ...base, restart: "on-failure" }, ["koi", "serve"])).toContain(
      "<key>SuccessfulExit</key>",
    );
  });
});
