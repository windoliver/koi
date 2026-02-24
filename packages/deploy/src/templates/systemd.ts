/**
 * systemd unit file template generator.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemdTemplateConfig {
  readonly name: string;
  readonly bunPath: string;
  readonly koiPath: string;
  readonly manifestPath: string;
  readonly workDir: string;
  readonly port: number;
  readonly restart: "on-failure" | "always" | "no";
  readonly restartDelaySec: number;
  readonly system: boolean;
  readonly envFile?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly user?: string | undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Characters unsafe in systemd unit values or shell interpolation. */
const UNSAFE_PATH_RE = /[\n\r\0'";$`\\|&<>]/;

function assertSafePath(value: string, label: string): void {
  if (UNSAFE_PATH_RE.test(value)) {
    throw new Error(`${label} contains unsafe characters: ${value}`);
  }
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export function generateSystemdUnit(config: SystemdTemplateConfig): string {
  // Validate all interpolated values before template generation
  assertSafePath(config.bunPath, "bunPath");
  assertSafePath(config.koiPath, "koiPath");
  assertSafePath(config.manifestPath, "manifestPath");
  assertSafePath(config.workDir, "workDir");
  assertSafePath(config.name, "name");
  assertValidPort(config.port);
  if (config.envFile !== undefined) assertSafePath(config.envFile, "envFile");
  if (config.dataDir !== undefined) assertSafePath(config.dataDir, "dataDir");
  if (config.user !== undefined) assertSafePath(config.user, "user");

  const wantedBy = config.system ? "multi-user.target" : "default.target";
  const dataDir = config.dataDir ?? config.workDir;

  const lines: readonly string[] = [
    "[Unit]",
    `Description=Koi Agent - ${config.name}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    ...(config.user !== undefined ? [`User=${config.user}`] : []),
    `WorkingDirectory=${config.workDir}`,
    `ExecStart=${config.bunPath} ${config.koiPath} serve --manifest ${config.manifestPath} --port ${config.port}`,
    `ExecStartPost=/bin/sh -c 'for i in 1 2 3 4 5; do curl -sf http://localhost:${config.port}/health && exit 0; sleep 1; done; exit 1'`,
    `Restart=${config.restart}`,
    `RestartSec=${config.restartDelaySec}s`,
    "RestartPreventExitStatus=78",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "StandardOutput=journal",
    "StandardError=journal",
    `SyslogIdentifier=koi-${config.name}`,
    // Security hardening — always applied
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    // Stricter hardening for system services
    ...(config.system
      ? ["ProtectSystem=strict", "ProtectHome=read-only", `ReadWritePaths=${dataDir}`]
      : []),
    ...(config.envFile !== undefined ? [`EnvironmentFile=-${config.envFile}`] : []),
    "",
    "[Install]",
    `WantedBy=${wantedBy}`,
    "",
  ];

  return lines.join("\n");
}
