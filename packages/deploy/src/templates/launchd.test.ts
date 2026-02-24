import { describe, expect, it } from "bun:test";
import { generateLaunchdPlist, type LaunchdTemplateConfig } from "./launchd.js";

const BASE_CONFIG: LaunchdTemplateConfig = {
  label: "com.koi.my-agent",
  name: "my-agent",
  bunPath: "/usr/local/bin/bun",
  koiPath: "/app/node_modules/.bin/koi",
  manifestPath: "/app/koi.yaml",
  workDir: "/app",
  port: 9100,
  restartDelaySec: 5,
  logDir: "/Users/test/Library/Logs/Koi/koi-my-agent",
};

describe("generateLaunchdPlist", () => {
  it("renders valid XML plist", () => {
    const output = generateLaunchdPlist(BASE_CONFIG);
    expect(output).toContain('<?xml version="1.0"');
    expect(output).toContain("<!DOCTYPE plist");
    expect(output).toContain('<plist version="1.0">');
    expect(output).toContain("</plist>");
  });

  it("includes the label", () => {
    const output = generateLaunchdPlist(BASE_CONFIG);
    expect(output).toContain("<string>com.koi.my-agent</string>");
  });

  it("includes ProgramArguments with serve command", () => {
    const output = generateLaunchdPlist(BASE_CONFIG);
    expect(output).toContain("<string>/usr/local/bin/bun</string>");
    expect(output).toContain("<string>serve</string>");
    expect(output).toContain("<string>--manifest</string>");
    expect(output).toContain("<string>/app/koi.yaml</string>");
    expect(output).toContain("<string>--port</string>");
    expect(output).toContain("<string>9100</string>");
  });

  it("includes WorkingDirectory", () => {
    const output = generateLaunchdPlist(BASE_CONFIG);
    expect(output).toContain("<key>WorkingDirectory</key>");
    expect(output).toContain("<string>/app</string>");
  });

  it("sets RunAtLoad to true", () => {
    const output = generateLaunchdPlist(BASE_CONFIG);
    expect(output).toContain("<key>RunAtLoad</key>");
    expect(output).toContain("<true/>");
  });

  it("sets KeepAlive with SuccessfulExit false", () => {
    const output = generateLaunchdPlist(BASE_CONFIG);
    expect(output).toContain("<key>KeepAlive</key>");
    expect(output).toContain("<key>SuccessfulExit</key>");
    expect(output).toContain("<false/>");
  });

  it("sets ThrottleInterval", () => {
    const output = generateLaunchdPlist(BASE_CONFIG);
    expect(output).toContain("<key>ThrottleInterval</key>");
    expect(output).toContain("<integer>5</integer>");
  });

  it("includes log paths", () => {
    const output = generateLaunchdPlist(BASE_CONFIG);
    expect(output).toContain("<key>StandardOutPath</key>");
    expect(output).toContain("stdout.log</string>");
    expect(output).toContain("<key>StandardErrorPath</key>");
    expect(output).toContain("stderr.log</string>");
  });

  it("includes PATH environment variable", () => {
    const output = generateLaunchdPlist(BASE_CONFIG);
    expect(output).toContain("<key>EnvironmentVariables</key>");
    expect(output).toContain("<key>PATH</key>");
    expect(output).toContain("/usr/local/bin:/usr/bin:/bin");
  });

  it("escapes XML special characters in paths", () => {
    const config: LaunchdTemplateConfig = {
      ...BASE_CONFIG,
      manifestPath: "/path/with <special> & chars",
    };
    const output = generateLaunchdPlist(config);
    expect(output).toContain("&lt;special&gt;");
    expect(output).toContain("&amp;");
  });

  it("uses custom port in arguments", () => {
    const output = generateLaunchdPlist({ ...BASE_CONFIG, port: 8080 });
    expect(output).toContain("<string>8080</string>");
  });

  it("uses custom throttle interval", () => {
    const output = generateLaunchdPlist({ ...BASE_CONFIG, restartDelaySec: 30 });
    expect(output).toContain("<integer>30</integer>");
  });
});
