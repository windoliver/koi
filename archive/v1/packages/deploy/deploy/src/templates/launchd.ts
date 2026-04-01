/**
 * launchd plist template generator for macOS.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaunchdTemplateConfig {
  readonly label: string;
  readonly name: string;
  readonly bunPath: string;
  readonly koiPath: string;
  readonly manifestPath: string;
  readonly workDir: string;
  readonly port: number;
  readonly restartDelaySec: number;
  readonly logDir: string;
  readonly envFile?: string | undefined;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Parse a dotenv-style file into key-value pairs.
 * Supports KEY=VALUE, ignores comments (#) and blank lines.
 * Does not expand variables — mirrors systemd EnvironmentFile semantics.
 */
function parseEnvFile(filePath: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const content = readFileSync(filePath, "utf-8");
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 1) continue;
    const key = line.slice(0, eqIdx).trim();
    // Strip optional surrounding quotes from value
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export function generateLaunchdPlist(config: LaunchdTemplateConfig): string {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }

  const args = [
    config.bunPath,
    config.koiPath,
    "serve",
    "--manifest",
    config.manifestPath,
    "--port",
    String(config.port),
  ];

  const argsXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");

  // Build environment variables: always include PATH, merge envFile if provided
  const envEntries = new Map<string, string>();
  envEntries.set("PATH", "/usr/local/bin:/usr/bin:/bin");

  if (config.envFile !== undefined) {
    for (const [key, value] of parseEnvFile(config.envFile)) {
      envEntries.set(key, value);
    }
  }

  const envLines = ["  <key>EnvironmentVariables</key>", "  <dict>"];
  for (const [key, value] of envEntries) {
    envLines.push(`    <key>${escapeXml(key)}</key>`);
    envLines.push(`    <string>${escapeXml(value)}</string>`);
  }
  envLines.push("  </dict>");
  const envVars = envLines.join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
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
  <string>${escapeXml(config.logDir)}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(config.logDir)}/stderr.log</string>
${envVars}
</dict>
</plist>
`;
}
