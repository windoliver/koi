import { constants, existsSync } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "@koi/config";
import { loadManifestConfig } from "./manifest.js";
import { resolveManifestPath } from "./resolve-manifest-path.js";

export type ServicePlatform = "linux" | "darwin";
export type ServiceRestart = "on-failure" | "always" | "no";
export type ServiceStatus = "running" | "stopped" | "failed" | "not-installed";

export interface ServiceConfig {
  readonly platform: ServicePlatform;
  readonly agentName: string;
  readonly serviceName: string;
  readonly launchdLabel: string;
  readonly manifestPath: string;
  readonly workDir: string;
  readonly port: number;
  readonly system: boolean;
  readonly restart: ServiceRestart;
  readonly restartDelaySec: number;
  readonly envFile: string | undefined;
  readonly logDir: string;
  readonly logPath: string;
  readonly stateDir: string;
  readonly lockFilePath: string;
  readonly serviceFilePath: string;
}

export interface ServiceInfo {
  readonly status: ServiceStatus;
  readonly pid: number | undefined;
  readonly uptimeMs: number | undefined;
  readonly memoryBytes: number | undefined;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecFn = (argv: readonly string[]) => Promise<ExecResult>;

export interface ServiceDeps {
  readonly exec?: ExecFn | undefined;
  readonly cwd?: string | undefined;
}

export interface ResolveServiceOptions {
  readonly manifest: string | undefined;
  readonly port: number | undefined;
  readonly system: boolean | undefined;
  readonly validateManifest?: boolean | undefined;
  readonly cwd?: string | undefined;
}

export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const DEFAULT_SERVICE_PORT = 9100;

const DEFAULT_RESTART: ServiceRestart = "on-failure";
const DEFAULT_RESTART_DELAY_SEC = 5;

export async function resolveServiceConfig(
  options: ResolveServiceOptions,
): Promise<ServiceResult<ServiceConfig>> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = resolveManifestPath(cwd, options.manifest, false);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (resolved.path === undefined) {
    const searched =
      resolved.searched.length > 0 ? `\nSearched:\n${resolved.searched.join("\n")}` : "";
    return {
      ok: false,
      error: `no koi.yaml found — pass --manifest <path> or create one with \`koi init\`${searched}`,
    };
  }

  if (options.validateManifest === true) {
    const validation = await loadManifestConfig(resolved.path, { skipAuditValidation: true });
    if (!validation.ok) return { ok: false, error: `invalid manifest — ${validation.error}` };
  }

  const rawResult = await loadConfig(resolved.path);
  if (!rawResult.ok) return { ok: false, error: rawResult.error.message };

  const manifestDir = dirname(resolved.path);
  const raw = rawResult.value as Record<string, unknown>;
  const deploy = parseDeployBlock(raw.deploy, manifestDir);
  if (!deploy.ok) return deploy;

  const agentName = parseAgentName(raw.name, manifestDir);
  const platform = detectPlatform();
  const serviceName = resolveServiceName(agentName);
  const launchdLabel = resolveLaunchdLabel(agentName);
  const system = options.system ?? deploy.value.system;
  const port = options.port ?? deploy.value.port;
  const logDir = deploy.value.logDir ?? resolveLogDir(platform, serviceName);
  const serviceDir = resolveServiceDir(platform, system);
  const serviceFilePath =
    platform === "linux"
      ? join(serviceDir, `${serviceName}.service`)
      : join(serviceDir, `${launchdLabel}.plist`);
  const stateDir = resolveStateDir(serviceName);

  return {
    ok: true,
    value: {
      platform,
      agentName,
      serviceName,
      launchdLabel,
      manifestPath: resolved.path,
      workDir: manifestDir,
      port,
      system,
      restart: deploy.value.restart,
      restartDelaySec: deploy.value.restartDelaySec,
      envFile: deploy.value.envFile,
      logDir,
      logPath: join(logDir, "service.log"),
      stateDir,
      lockFilePath: join(stateDir, "gateway-http.lock"),
      serviceFilePath,
    },
  };
}

export async function validateServiceManifest(manifestPath: string): Promise<ServiceResult<void>> {
  const validation = await loadManifestConfig(manifestPath, { skipAuditValidation: true });
  if (!validation.ok) return { ok: false, error: `invalid manifest — ${validation.error}` };
  return { ok: true, value: undefined };
}

export async function installService(config: ServiceConfig, deps?: ServiceDeps): Promise<void> {
  const exec = deps?.exec ?? execCommand;
  await mkdir(dirname(config.serviceFilePath), { recursive: true });
  await mkdir(config.logDir, { recursive: true });
  await mkdir(config.stateDir, { recursive: true });

  const content =
    config.platform === "linux"
      ? generateSystemdUnit(config)
      : generateLaunchdPlist(config, buildLaunchdServiceArgv(config));
  await writeFile(config.serviceFilePath, content, { mode: 0o644 });

  if (config.platform === "linux") {
    const userFlag = config.system ? [] : ["--user"];
    await checked(exec, ["systemctl", ...userFlag, "daemon-reload"], "reload systemd");
    await checked(exec, ["systemctl", ...userFlag, "enable", config.serviceName], "enable service");
    await checked(exec, ["systemctl", ...userFlag, "restart", config.serviceName], "start service");
    return;
  }

  const domain = launchdDomain(config.system);
  await bestEffortBootout(exec, domain, config.launchdLabel);
  await checked(
    exec,
    ["launchctl", "bootstrap", domain, config.serviceFilePath],
    "bootstrap service",
  );
  await checked(
    exec,
    ["launchctl", "kickstart", "-k", `${domain}/${config.launchdLabel}`],
    "start service",
  );
}

export async function uninstallService(config: ServiceConfig, deps?: ServiceDeps): Promise<void> {
  const exec = deps?.exec ?? execCommand;
  if (config.platform === "linux") {
    const userFlag = config.system ? [] : ["--user"];
    await bestEffort(exec, ["systemctl", ...userFlag, "stop", config.serviceName]);
    await bestEffort(exec, ["systemctl", ...userFlag, "disable", config.serviceName]);
    await rm(config.serviceFilePath, { force: true });
    await checked(exec, ["systemctl", ...userFlag, "daemon-reload"], "reload systemd");
    return;
  }

  await bestEffortBootout(exec, launchdDomain(config.system), config.launchdLabel);
  await rm(config.serviceFilePath, { force: true });
}

export async function stopService(config: ServiceConfig, deps?: ServiceDeps): Promise<void> {
  const exec = deps?.exec ?? execCommand;
  if (config.platform === "linux") {
    const userFlag = config.system ? [] : ["--user"];
    await checked(exec, ["systemctl", ...userFlag, "stop", config.serviceName], "stop service");
    return;
  }
  await bestEffortBootout(exec, launchdDomain(config.system), config.launchdLabel);
}

export async function serviceStatus(
  config: ServiceConfig,
  deps?: ServiceDeps,
): Promise<ServiceInfo> {
  const exec = deps?.exec ?? execCommand;
  if (config.platform === "linux") return systemdStatus(config, exec);
  return launchdStatus(config, exec);
}

export async function* serviceLogs(
  config: ServiceConfig,
  lines: number,
  follow: boolean,
): AsyncIterable<string> {
  try {
    await access(config.logPath, constants.R_OK);
  } catch {
    yield `No service logs found at ${config.logPath}\n`;
    return;
  }

  const proc = Bun.spawn(["tail", ...(follow ? ["-f"] : []), "-n", String(lines), config.logPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
    proc.kill();
  }
}

export function serviceHealthUrl(config: ServiceConfig): string {
  return `http://127.0.0.1:${config.port}/healthz`;
}

export async function probeServiceHealth(
  config: ServiceConfig,
  timeoutMs: number,
): Promise<ServiceResult<{ readonly ok: boolean; readonly status: number | undefined }>> {
  try {
    const res = await fetch(serviceHealthUrl(config), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, value: { ok: res.ok, status: res.status } };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function resolveServiceName(agentName: string): string {
  return `koi-${sanitizeName(agentName)}`;
}

export function resolveLaunchdLabel(agentName: string): string {
  return `com.koi.${sanitizeName(agentName)}`;
}

export function generateSystemdUnit(config: ServiceConfig): string {
  const serviceArgv = buildServiceArgv(config).map(systemdQuote).join(" ");
  const envLines = [
    `Environment=KOI_SERVICE_NAME=${systemdQuote(config.serviceName)}`,
    `Environment=KOI_SERVICE_MANIFEST=${systemdQuote(config.manifestPath)}`,
    `Environment=KOI_SERVICE_LOG_FILE=${systemdQuote(config.logPath)}`,
    `Environment=KOI_SERVICE_PORT=${config.port}`,
  ];
  const wantedBy = config.system ? "multi-user.target" : "default.target";

  return [
    "[Unit]",
    `Description=Koi service ${config.agentName}`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdQuote(config.workDir)}`,
    `ExecStart=${serviceArgv}`,
    `Restart=${config.restart}`,
    `RestartSec=${config.restartDelaySec}s`,
    "RestartPreventExitStatus=78",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    `StandardOutput=append:${config.logPath}`,
    `StandardError=append:${config.logPath}`,
    ...envLines,
    ...(config.envFile !== undefined ? [`EnvironmentFile=-${systemdQuote(config.envFile)}`] : []),
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "",
    "[Install]",
    `WantedBy=${wantedBy}`,
    "",
  ].join("\n");
}

export function generateLaunchdPlist(
  config: ServiceConfig,
  serviceArgv: readonly string[],
): string {
  const args = serviceArgv.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");
  const env = [
    ["PATH", "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"],
    ["KOI_SERVICE_NAME", config.serviceName],
    ["KOI_SERVICE_MANIFEST", config.manifestPath],
    ["KOI_SERVICE_LOG_FILE", config.logPath],
    ["KOI_SERVICE_PORT", String(config.port)],
  ] as const;
  const envXml = env
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(config.launchdLabel)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(config.workDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${config.restartDelaySec}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(config.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

interface DeployBlock {
  readonly port: number;
  readonly restart: ServiceRestart;
  readonly restartDelaySec: number;
  readonly envFile: string | undefined;
  readonly logDir: string | undefined;
  readonly system: boolean;
}

function parseDeployBlock(raw: unknown, manifestDir: string): ServiceResult<DeployBlock> {
  if (raw === undefined) {
    return {
      ok: true,
      value: {
        port: DEFAULT_SERVICE_PORT,
        restart: DEFAULT_RESTART,
        restartDelaySec: DEFAULT_RESTART_DELAY_SEC,
        envFile: undefined,
        logDir: undefined,
        system: false,
      },
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "manifest.deploy must be an object when present" };
  }

  const rec = raw as Record<string, unknown>;
  const port = parseIntegerField(rec.port, "manifest.deploy.port", 1, 65_535);
  if (!port.ok) return { ok: false, error: port.error };
  const restart = parseRestartField(rec.restart);
  if (!restart.ok) return { ok: false, error: restart.error };
  const restartDelaySec = parseIntegerField(
    rec.restartDelaySec,
    "manifest.deploy.restartDelaySec",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (!restartDelaySec.ok) return { ok: false, error: restartDelaySec.error };
  const system = parseBooleanField(rec.system, "manifest.deploy.system");
  if (!system.ok) return { ok: false, error: system.error };
  const envFile = parsePathField(rec.envFile, "manifest.deploy.envFile", manifestDir);
  if (!envFile.ok) return { ok: false, error: envFile.error };
  const logDir = parsePathField(rec.logDir, "manifest.deploy.logDir", manifestDir);
  if (!logDir.ok) return { ok: false, error: logDir.error };

  return {
    ok: true,
    value: {
      port: port.value ?? DEFAULT_SERVICE_PORT,
      restart: restart.value ?? DEFAULT_RESTART,
      restartDelaySec: restartDelaySec.value ?? DEFAULT_RESTART_DELAY_SEC,
      envFile: envFile.value,
      logDir: logDir.value,
      system: system.value ?? false,
    },
  };
}

function parseAgentName(rawName: unknown, manifestDir: string): string {
  if (typeof rawName === "string" && rawName.trim().length > 0) return rawName.trim();
  const fallback = basename(manifestDir);
  return fallback.length > 0 ? fallback : "agent";
}

function parseIntegerField(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): ServiceResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    return { ok: false, error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value: raw };
}

function parseBooleanField(raw: unknown, field: string): ServiceResult<boolean | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "boolean") return { ok: false, error: `${field} must be a boolean` };
  return { ok: true, value: raw };
}

function parseRestartField(raw: unknown): ServiceResult<ServiceRestart | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === "on-failure" || raw === "always" || raw === "no") {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error: 'manifest.deploy.restart must be one of "on-failure", "always", or "no"',
  };
}

function parsePathField(
  raw: unknown,
  field: string,
  manifestDir: string,
): ServiceResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: `${field} must be a non-empty string` };
  }
  const trimmed = raw.trim();
  return { ok: true, value: isAbsolute(trimmed) ? trimmed : resolve(manifestDir, trimmed) };
}

function detectPlatform(): ServicePlatform {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "darwin";
  throw new Error(
    `Unsupported platform: ${process.platform}. Only linux and darwin are supported.`,
  );
}

function resolveServiceDir(platform: ServicePlatform, system: boolean): string {
  if (platform === "linux") {
    return system ? "/etc/systemd/system" : join(homedir(), ".config", "systemd", "user");
  }
  return system ? "/Library/LaunchDaemons" : join(homedir(), "Library", "LaunchAgents");
}

function resolveLogDir(platform: ServicePlatform, serviceName: string): string {
  const envLogDir = process.env.KOI_LOG_DIR;
  if (envLogDir !== undefined && envLogDir.length > 0) return join(envLogDir, serviceName);
  if (platform === "linux") return join(homedir(), ".local", "share", "koi", "logs", serviceName);
  return join(homedir(), "Library", "Logs", "Koi", serviceName);
}

function resolveStateDir(serviceName: string): string {
  const envStateDir = process.env.KOI_STATE_DIR;
  const root =
    envStateDir !== undefined && envStateDir.length > 0 ? envStateDir : join(homedir(), ".koi");
  return join(root, "services", serviceName);
}

function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized : "agent";
}

function buildServiceArgv(config: ServiceConfig): readonly string[] {
  const koiPath = detectKoiPath(config.workDir);
  const base = isScriptEntrypoint(koiPath) ? [detectBunPath(), koiPath] : [koiPath];
  return [
    ...base,
    "serve",
    "--manifest",
    config.manifestPath,
    "--port",
    String(config.port),
    "--log-format",
    "text",
  ];
}

function buildLaunchdServiceArgv(config: ServiceConfig): readonly string[] {
  const serviceArgv = buildServiceArgv(config);
  if (config.envFile === undefined) return serviceArgv;
  return [
    "/bin/sh",
    "-lc",
    `set -a; . ${shellQuote(config.envFile)}; set +a; exec ${serviceArgv.map(shellQuote).join(" ")}`,
  ];
}

function detectBunPath(): string {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    const found = Bun.which("bun");
    if (found !== null) return found;
  }
  return process.execPath;
}

function detectKoiPath(workDir: string): string {
  const current = process.argv[1];
  if (current !== undefined && (current.endsWith("bin.ts") || current.endsWith("bin.js"))) {
    return current;
  }
  const candidates = [
    typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which("koi") : null,
    resolve(workDir, "node_modules", ".bin", "koi"),
    resolve(workDir, "packages", "meta", "cli", "dist", "bin.js"),
    resolve(workDir, "packages", "meta", "cli", "src", "bin.ts"),
    resolve(workDir, "node_modules", "@koi-agent", "cli", "dist", "bin.js"),
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && fileExistsSync(candidate))
      return candidate;
  }
  return "koi";
}

function isScriptEntrypoint(path: string): boolean {
  return path.endsWith(".js") || path.endsWith(".ts");
}

function fileExistsSync(path: string): boolean {
  return existsSync(path);
}

function launchdDomain(system: boolean): string {
  return system ? "system" : `gui/${process.getuid?.() ?? 501}`;
}

async function launchdStatus(config: ServiceConfig, exec: ExecFn): Promise<ServiceInfo> {
  const result = await exec([
    "launchctl",
    "print",
    `${launchdDomain(config.system)}/${config.launchdLabel}`,
  ]);
  if (result.exitCode !== 0) {
    return {
      status: (await fileReadable(config.serviceFilePath)) ? "stopped" : "not-installed",
      pid: undefined,
      uptimeMs: undefined,
      memoryBytes: undefined,
    };
  }
  const pidMatch = /pid\s*=\s*(\d+)/.exec(result.stdout);
  const pid = pidMatch?.[1] !== undefined ? Number.parseInt(pidMatch[1], 10) : undefined;
  const status: ServiceStatus = result.stdout.includes("state = running") ? "running" : "stopped";
  if (status === "running" && pid !== undefined && pid > 0) {
    const ps = await exec(["ps", "-o", "rss=,etime=", "-p", String(pid)]);
    const parsed =
      ps.exitCode === 0
        ? parsePsOutput(ps.stdout)
        : { uptimeMs: undefined, memoryBytes: undefined };
    return { status, pid, uptimeMs: parsed.uptimeMs, memoryBytes: parsed.memoryBytes };
  }
  return { status, pid, uptimeMs: undefined, memoryBytes: undefined };
}

async function systemdStatus(config: ServiceConfig, exec: ExecFn): Promise<ServiceInfo> {
  const userFlag = config.system ? [] : ["--user"];
  const result = await exec([
    "systemctl",
    ...userFlag,
    "show",
    "--property=ActiveState,MainPID,ExecMainStartTimestamp,MemoryCurrent",
    config.serviceName,
  ]);
  if (result.exitCode !== 0) {
    return {
      status: (await fileReadable(config.serviceFilePath)) ? "stopped" : "not-installed",
      pid: undefined,
      uptimeMs: undefined,
      memoryBytes: undefined,
    };
  }
  const props = parseKeyValueLines(result.stdout);
  const activeState = props.get("ActiveState") ?? "";
  const mainPid = Number.parseInt(props.get("MainPID") ?? "0", 10);
  const status: ServiceStatus =
    activeState === "active" ? "running" : activeState === "failed" ? "failed" : "stopped";
  const startTime = Date.parse(props.get("ExecMainStartTimestamp") ?? "");
  const memory = Number.parseInt(props.get("MemoryCurrent") ?? "", 10);
  return {
    status,
    pid: mainPid > 0 ? mainPid : undefined,
    uptimeMs: status === "running" && !Number.isNaN(startTime) ? Date.now() - startTime : undefined,
    memoryBytes: Number.isNaN(memory) ? undefined : memory,
  };
}

async function fileReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function parseKeyValueLines(output: string): ReadonlyMap<string, string> {
  const props = new Map<string, string>();
  for (const line of output.split("\n")) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    props.set(line.slice(0, idx), line.slice(idx + 1).trim());
  }
  return props;
}

function parsePsOutput(output: string): {
  readonly uptimeMs: number | undefined;
  readonly memoryBytes: number | undefined;
} {
  const parts = output.trim().split(/\s+/);
  const rssKb = Number.parseInt(parts[0] ?? "", 10);
  return {
    memoryBytes: Number.isNaN(rssKb) ? undefined : rssKb * 1024,
    uptimeMs: parseElapsed(parts[1] ?? ""),
  };
}

function parseElapsed(value: string): number | undefined {
  let days = 0;
  let rest = value;
  const dayMatch = /^(\d+)-(.+)$/.exec(value);
  if (dayMatch !== null) {
    days = Number.parseInt(dayMatch[1] ?? "0", 10);
    rest = dayMatch[2] ?? "";
  }
  const parts = rest.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some(Number.isNaN)) return undefined;
  if (parts.length === 2) {
    const [minutes, seconds] = parts as [number, number];
    return ((days * 24 * 60 + minutes) * 60 + seconds) * 1000;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts as [number, number, number];
    return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  }
  return undefined;
}

async function bestEffort(exec: ExecFn, argv: readonly string[]): Promise<void> {
  await exec(argv);
}

async function bestEffortBootout(exec: ExecFn, domain: string, label: string): Promise<void> {
  await bestEffort(exec, ["launchctl", "bootout", `${domain}/${label}`]);
}

async function checked(exec: ExecFn, argv: readonly string[], action: string): Promise<void> {
  const result = await exec(argv);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to ${action}: ${result.stderr || result.stdout || argv.join(" ")}`);
  }
}

async function execCommand(argv: readonly string[]): Promise<ExecResult> {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function systemdQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value.replace(/%/g, "%%");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
