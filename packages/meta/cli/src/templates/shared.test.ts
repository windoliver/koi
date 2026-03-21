import { describe, expect, test } from "bun:test";
import type { WizardState } from "../wizard/state.js";
import {
  generateDemoEnvFile,
  generateDemoManifestYaml,
  generateManifestYaml,
  generatePackageJson,
  generateReadme,
  generateTsconfig,
} from "./shared.js";

const STATE: WizardState = {
  template: "minimal",
  name: "test-agent",
  description: "A test agent",
  model: "anthropic:claude-sonnet-4-5-20250929",
  engine: undefined,
  channels: ["cli"],
  directory: "test-agent",
  koiCommand: "koi",
  preset: "local",
  addons: [],
  demoPack: undefined,
  dataSources: [],
  apiKey: undefined,
  stacks: [],
  channelTokens: {},
};

describe("generateManifestYaml", () => {
  test("includes name and version", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain("name: test-agent");
    expect(yaml).toContain("version: 0.1.0");
  });

  test("includes description", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain("description: A test agent");
  });

  test("includes model as string shorthand", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain('model: "anthropic:claude-sonnet-4-5-20250929"');
  });

  test("includes preset field", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain("preset: local");
  });

  test("omits engine when using the default pi runtime", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).not.toContain("engine:");
  });

  test("includes engine when explicitly overridden", () => {
    const yaml = generateManifestYaml({ ...STATE, engine: "@koi/engine-external" });
    expect(yaml).toContain("engine: @koi/engine-external");
  });

  test("includes channels section with cli by default", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain("channels:");
    expect(yaml).toContain("@koi/channel-cli");
  });

  test("includes channels for copilot", () => {
    const copilotState: WizardState = {
      ...STATE,
      template: "copilot",
      channels: ["cli", "telegram", "slack"],
    };
    const yaml = generateManifestYaml(copilotState);
    expect(yaml).toContain("telegram");
    expect(yaml).toContain("slack");
  });

  test("copilot template includes working built-in tools", () => {
    const yaml = generateManifestYaml({ ...STATE, template: "copilot" });
    expect(yaml).toContain("@koi/tool-ask-user");
    expect(yaml).toContain("@koi/tools-web");
  });

  test("includes local Nexus guidance comments", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain("Leave nexus.url unset for local embed mode.");
    expect(yaml).toContain("# nexus:");
  });

  test("includes bootstrap context by default", () => {
    const yaml = generateManifestYaml(STATE);
    expect(yaml).toContain("context:");
    expect(yaml).toContain("bootstrap: true");
  });

  test("quotes model string containing colons", () => {
    const yaml = generateManifestYaml(STATE);
    // Model strings contain colons and must be quoted
    expect(yaml).toMatch(/model:\s+"[^"]+"/);
  });
});

describe("generatePackageJson", () => {
  test("includes correct name", () => {
    const result = JSON.parse(generatePackageJson(STATE));
    expect(result.name).toBe("test-agent");
  });

  test("sets type to module", () => {
    const result = JSON.parse(generatePackageJson(STATE));
    expect(result.type).toBe("module");
  });

  test("includes supported scripts", () => {
    const result = JSON.parse(generatePackageJson(STATE));
    expect(result.scripts.koi).toBe("koi");
    expect(result.scripts["dry-run"]).toBe("bun run koi -- start --dry-run");
    expect(result.scripts.start).toBe("bun run koi -- start");
    expect(result.scripts["start:admin"]).toBe("bun run koi -- start --admin");
    expect(result.scripts.serve).toBe("bun run koi -- serve");
    expect(result.scripts["serve:admin"]).toBe("bun run koi -- serve --admin");
    expect(result.scripts.admin).toBe("bun run koi -- admin");
    expect(result.scripts.tui).toBe("bun run koi -- tui");
    expect(result.scripts["tui:serve"]).toBe(
      "bun run koi -- tui --url http://localhost:9100/admin/api",
    );
    expect(result.scripts.doctor).toBe("bun run koi -- doctor");
  });

  test("uses the single-package koi dependency", () => {
    const result = JSON.parse(generatePackageJson(STATE));
    expect(result.dependencies.koi).toBe("latest");
    expect(result.dependencies["@koi/core"]).toBeUndefined();
  });

  test("omits the published dependency when using the local monorepo CLI", () => {
    const result = JSON.parse(
      generatePackageJson({ ...STATE, koiCommand: "../packages/meta/cli/dist/bin.js" }),
    );
    expect(result.scripts.koi).toBe("../packages/meta/cli/dist/bin.js");
    expect(result.dependencies).toBeUndefined();
  });

  test("output is valid JSON", () => {
    expect(() => JSON.parse(generatePackageJson(STATE))).not.toThrow();
  });
});

describe("generateTsconfig", () => {
  test("output is valid JSON", () => {
    expect(() => JSON.parse(generateTsconfig())).not.toThrow();
  });

  test("has strict mode enabled", () => {
    const result = JSON.parse(generateTsconfig());
    expect(result.compilerOptions.strict).toBe(true);
  });

  test("targets ESM", () => {
    const result = JSON.parse(generateTsconfig());
    expect(result.compilerOptions.module).toBe("NodeNext");
  });
});

describe("generateReadme", () => {
  test("includes agent name as heading", () => {
    const readme = generateReadme(STATE);
    expect(readme).toContain("# test-agent");
  });

  test("includes description", () => {
    const readme = generateReadme(STATE);
    expect(readme).toContain("A test agent");
  });

  test("includes first-run section with koi up", () => {
    const readme = generateReadme(STATE);
    expect(readme).toContain("First Run");
    expect(readme).toContain("bun install");
    expect(readme).toContain("bun run up");
    expect(readme).toContain("Admin panel");
  });

  test("includes local Nexus prerequisite guidance", () => {
    const readme = generateReadme(STATE);
    expect(readme).toContain("uv run nexus");
  });

  test("documents the local monorepo CLI when scaffolded inside the repo", () => {
    const readme = generateReadme({
      ...STATE,
      koiCommand: "../packages/meta/cli/dist/bin.js",
    });
    expect(readme).toContain("wired to the local Koi monorepo CLI");
    expect(readme).toContain("bun run build:cli");
    expect(readme).not.toContain("bun install");
  });

  test("includes Nexus switching guidance", () => {
    const readme = generateReadme(STATE);
    expect(readme).toContain("Leave `nexus.url` unset for local embed mode.");
    expect(readme).toContain("https://nexus.example.com");
  });
});

// ---------------------------------------------------------------------------
// Demo manifest + env
// ---------------------------------------------------------------------------

const DEMO_STATE: WizardState = {
  template: "minimal",
  name: "herb-demo",
  description: "HERB enterprise demo agent",
  model: "anthropic:claude-sonnet-4-5-20250929",
  engine: undefined,
  channels: ["cli"],
  directory: "herb-demo",
  koiCommand: "koi",
  preset: "demo",
  addons: [],
  demoPack: "connected",
  dataSources: [],
  apiKey: undefined,
  stacks: [],
  channelTokens: {},
};

describe("generateDemoManifestYaml", () => {
  test("includes preset: demo", () => {
    const yaml = generateDemoManifestYaml(DEMO_STATE);
    expect(yaml).toContain("preset: demo");
  });

  test("includes autonomous: enabled: true", () => {
    const yaml = generateDemoManifestYaml(DEMO_STATE);
    expect(yaml).toContain("autonomous:");
    expect(yaml).toContain("  enabled: true");
  });

  test("includes forge: enabled: true", () => {
    const yaml = generateDemoManifestYaml(DEMO_STATE);
    expect(yaml).toContain("forge:");
    expect(yaml).toContain("  enabled: true");
  });

  test("includes soul reference", () => {
    const yaml = generateDemoManifestYaml(DEMO_STATE);
    expect(yaml).toContain('soul: ".koi/SOUL.md"');
  });

  test("includes tools block with all verified tools", () => {
    const yaml = generateDemoManifestYaml(DEMO_STATE);
    expect(yaml).toContain("tools:");
    expect(yaml).toContain("@koi/tool-ask-user");
    expect(yaml).toContain("@koi/tools-web");
    expect(yaml).toContain("@koi/tool-exec");
    expect(yaml).toContain("@koi/tool-browser");
  });

  test("includes demo pack", () => {
    const yaml = generateDemoManifestYaml(DEMO_STATE);
    expect(yaml).toContain("demo:");
    expect(yaml).toContain("  pack: connected");
  });

  test("includes context bootstrap", () => {
    const yaml = generateDemoManifestYaml(DEMO_STATE);
    expect(yaml).toContain("context:");
    expect(yaml).toContain("  bootstrap: true");
  });

  test("includes dataSources with HERB Nexus entries", () => {
    const yaml = generateDemoManifestYaml(DEMO_STATE);
    expect(yaml).toContain("dataSources:");
    expect(yaml).toContain("herb-employees");
    expect(yaml).toContain("herb-customers");
    expect(yaml).toContain("herb-products");
    expect(yaml).toContain("protocol: nexus");
  });
});

describe("generateDemoEnvFile", () => {
  test("includes auto-generated NEXUS_API_KEY", () => {
    const env = generateDemoEnvFile(DEMO_STATE);
    expect(env).toContain("NEXUS_API_KEY=sk-koi-demo-");
  });

  test("includes model env key", () => {
    const env = generateDemoEnvFile(DEMO_STATE);
    expect(env).toContain("ANTHROPIC_API_KEY=");
  });

  test("includes addon channel env keys", () => {
    const stateWithAddons: WizardState = {
      ...DEMO_STATE,
      addons: ["slack"],
    };
    const env = generateDemoEnvFile(stateWithAddons);
    expect(env).toContain("SLACK_BOT_TOKEN=");
    expect(env).toContain("SLACK_APP_TOKEN=");
  });
});
