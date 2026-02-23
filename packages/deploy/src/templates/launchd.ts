/**
 * launchd plist template generator for macOS.
 */

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

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export function renderLaunchdPlist(config: LaunchdTemplateConfig): string {
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

  const envVars = [
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    "    <string>/usr/local/bin:/usr/bin:/bin</string>",
    "  </dict>",
  ].join("\n");

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
