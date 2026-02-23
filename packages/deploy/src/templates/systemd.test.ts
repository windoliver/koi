import { describe, expect, it } from "bun:test";
import { renderSystemdUnit, type SystemdTemplateConfig } from "./systemd.js";

const BASE_CONFIG: SystemdTemplateConfig = {
  name: "my-agent",
  bunPath: "/usr/local/bin/bun",
  koiPath: "/app/node_modules/.bin/koi",
  manifestPath: "/app/koi.yaml",
  workDir: "/app",
  port: 9100,
  restart: "on-failure",
  restartDelaySec: 5,
  system: false,
};

describe("renderSystemdUnit", () => {
  it("renders a valid systemd unit file", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).toContain("[Unit]");
    expect(output).toContain("[Service]");
    expect(output).toContain("[Install]");
  });

  it("includes the agent name in Description", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).toContain("Description=Koi Agent - my-agent");
  });

  it("uses correct ExecStart command", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).toContain(
      "ExecStart=/usr/local/bin/bun /app/node_modules/.bin/koi serve --manifest /app/koi.yaml --port 9100",
    );
  });

  it("includes health check in ExecStartPost", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).toContain("ExecStartPost=");
    expect(output).toContain("curl -sf http://localhost:9100/health");
  });

  it("sets restart policy", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).toContain("Restart=on-failure");
  });

  it("sets restart delay", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).toContain("RestartSec=5s");
  });

  it("prevents restart on config error (exit 78)", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).toContain("RestartPreventExitStatus=78");
  });

  it("sets WantedBy=default.target for user services", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).toContain("WantedBy=default.target");
  });

  it("sets WantedBy=multi-user.target for system services", () => {
    const output = renderSystemdUnit({ ...BASE_CONFIG, system: true });
    expect(output).toContain("WantedBy=multi-user.target");
  });

  it("includes base security hardening for all services", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).toContain("NoNewPrivileges=yes");
    expect(output).toContain("PrivateTmp=yes");
  });

  it("includes stricter hardening for system services", () => {
    const output = renderSystemdUnit({ ...BASE_CONFIG, system: true });
    expect(output).toContain("ProtectSystem=strict");
    expect(output).toContain("ProtectHome=read-only");
    expect(output).toContain("NoNewPrivileges=yes");
    expect(output).toContain("PrivateTmp=yes");
  });

  it("omits ProtectSystem for user services", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).not.toContain("ProtectSystem=strict");
    expect(output).not.toContain("ProtectHome=read-only");
  });

  it("includes EnvironmentFile when envFile is set", () => {
    const output = renderSystemdUnit({ ...BASE_CONFIG, envFile: "/app/.env" });
    expect(output).toContain("EnvironmentFile=-/app/.env");
  });

  it("omits EnvironmentFile when envFile is not set", () => {
    const output = renderSystemdUnit(BASE_CONFIG);
    expect(output).not.toContain("EnvironmentFile");
  });

  it("includes User when user is set", () => {
    const output = renderSystemdUnit({ ...BASE_CONFIG, user: "koi" });
    expect(output).toContain("User=koi");
  });

  it("handles restart: always", () => {
    const output = renderSystemdUnit({ ...BASE_CONFIG, restart: "always" });
    expect(output).toContain("Restart=always");
  });

  it("handles restart: no", () => {
    const output = renderSystemdUnit({ ...BASE_CONFIG, restart: "no" });
    expect(output).toContain("Restart=no");
  });

  // -- Input validation (security) ------------------------------------------

  it("rejects manifestPath with shell metacharacters", () => {
    expect(() =>
      renderSystemdUnit({ ...BASE_CONFIG, manifestPath: "/app/$(whoami).yaml" }),
    ).toThrow("manifestPath contains unsafe characters");
  });

  it("rejects bunPath with newlines", () => {
    expect(() =>
      renderSystemdUnit({ ...BASE_CONFIG, bunPath: "/usr/bin/bun\nExecStartPost=/bin/evil" }),
    ).toThrow("bunPath contains unsafe characters");
  });

  it("rejects name with semicolons", () => {
    expect(() => renderSystemdUnit({ ...BASE_CONFIG, name: "agent;rm -rf /" })).toThrow(
      "name contains unsafe characters",
    );
  });

  it("rejects port 0", () => {
    expect(() => renderSystemdUnit({ ...BASE_CONFIG, port: 0 })).toThrow("Invalid port");
  });

  it("rejects port 70000", () => {
    expect(() => renderSystemdUnit({ ...BASE_CONFIG, port: 70000 })).toThrow("Invalid port");
  });

  it("rejects envFile with backticks", () => {
    expect(() => renderSystemdUnit({ ...BASE_CONFIG, envFile: "/app/`whoami`.env" })).toThrow(
      "envFile contains unsafe characters",
    );
  });
});
