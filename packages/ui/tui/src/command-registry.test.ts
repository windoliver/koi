import { describe, expect, test } from "bun:test";
import {
  ALL_COMMANDS,
  CATEGORY_ORDER,
  type CommandMeta,
  getPaletteCommands,
  getViewCommands,
  VIEW_COMMAND_MAP,
} from "./command-registry.js";

describe("ALL_COMMANDS", () => {
  test("every command has required fields", () => {
    for (const cmd of ALL_COMMANDS) {
      expect(typeof cmd.id).toBe("string");
      expect(cmd.id.length).toBeGreaterThan(0);
      expect(typeof cmd.label).toBe("string");
      expect(typeof cmd.description).toBe("string");
      expect(typeof cmd.category).toBe("string");
    }
  });

  test("no duplicate command IDs", () => {
    const seen = new Set<string>();
    for (const cmd of ALL_COMMANDS) {
      if (seen.has(cmd.id)) {
        throw new Error(`Duplicate command ID: "${cmd.id}"`);
      }
      seen.add(cmd.id);
    }
  });

  test("no duplicate Ctrl shortcuts", () => {
    const ctrlCmds = ALL_COMMANDS.filter((c) => c.ctrlShortcut !== undefined);
    const seen = new Map<string, string>();
    for (const cmd of ctrlCmds) {
      const existing = seen.get(cmd.ctrlShortcut as string);
      if (existing !== undefined) {
        throw new Error(
          `Ctrl shortcut "${cmd.ctrlShortcut}" claimed by both "${existing}" and "${cmd.id}"`,
        );
      }
      seen.set(cmd.ctrlShortcut as string, cmd.id);
    }
  });

  test("contains core commands", () => {
    const ids = ALL_COMMANDS.map((c) => c.id);
    expect(ids).toContain("agents");
    expect(ids).toContain("dispatch");
    expect(ids).toContain("refresh");
    expect(ids).toContain("quit");
    expect(ids).toContain("palette");
  });

  test("category values are valid", () => {
    const validCategories = new Set(CATEGORY_ORDER.map((c) => c.key));
    for (const cmd of ALL_COMMANDS) {
      expect(validCategories.has(cmd.category)).toBe(true);
    }
  });
});

describe("VIEW_COMMAND_MAP", () => {
  test("has entries for all views", () => {
    const views = [
      "agents",
      "console",
      "forge",
      "governance",
      "temporal",
      "scheduler",
      "harness",
      "datasources",
      "consent",
      "service",
      "logs",
      "debug",
      "files",
      "scratchpad",
      "welcome",
      "palette",
      "channels",
      "channelspicker",
    ];
    for (const view of views) {
      const entry = VIEW_COMMAND_MAP[view as keyof typeof VIEW_COMMAND_MAP];
      expect(entry).toBeDefined();
      expect(typeof entry.footerHint).toBe("string");
      expect(Array.isArray(entry.commands)).toBe(true);
    }
  });

  test("governance view has approve and deny shortcuts", () => {
    const gov = getViewCommands("governance");
    const shortcuts = gov.commands.map((c) => c.shortcut);
    expect(shortcuts).toContain("a");
    expect(shortcuts).toContain("d");
  });

  test("forge view has promote, demote, quarantine shortcuts", () => {
    const forge = getViewCommands("forge");
    const shortcuts = forge.commands.map((c) => c.shortcut);
    expect(shortcuts).toContain("p");
    expect(shortcuts).toContain("d");
    expect(shortcuts).toContain("q");
  });

  test("temporal view has signal and terminate shortcuts", () => {
    const temporal = getViewCommands("temporal");
    const shortcuts = temporal.commands.map((c) => c.shortcut);
    expect(shortcuts).toContain("s");
    expect(shortcuts).toContain("t");
  });

  test("footer hints contain Esc:back for domain views", () => {
    const domainViews = ["governance", "forge", "temporal", "scheduler", "skills"];
    for (const view of domainViews) {
      const hint = getViewCommands(view as "governance").footerHint;
      expect(hint).toContain("Esc:back");
    }
  });

  test("footer hints contain Ctrl+P:commands for boardroom views", () => {
    const boardViews = ["skills", "channels", "system", "nexus"];
    for (const view of boardViews) {
      const hint = getViewCommands(view as "skills").footerHint;
      expect(hint).toContain("Ctrl+P:commands");
    }
  });

  test("wizard views do NOT have Ctrl+P in footer", () => {
    const wizardViews = ["channelspicker", "model", "addons", "engine", "nexusconfig"];
    for (const view of wizardViews) {
      const hint = getViewCommands(view as "channelspicker").footerHint;
      expect(hint).not.toContain("Ctrl+P");
    }
  });

  test("console shows Type message and Enter:send", () => {
    const hint = getViewCommands("console").footerHint;
    expect(hint).toContain("Type message");
    expect(hint).toContain("Enter:send");
  });

  test("palette shows Esc:close, not Esc:back", () => {
    const hint = getViewCommands("palette").footerHint;
    expect(hint).toContain("Esc:close");
    expect(hint).not.toContain("Esc:back");
    expect(hint).toContain("Enter:select");
  });

  test("splitpanes shows Tab:focus-next and +:cycle-zoom", () => {
    const hint = getViewCommands("splitpanes").footerHint;
    expect(hint).toContain("Tab:focus-next");
    expect(hint).toContain("Enter:zoom");
    expect(hint).toContain("+:cycle-zoom");
  });

  test("welcome shows ?:details and q:quit", () => {
    const hint = getViewCommands("welcome").footerHint;
    expect(hint).toContain("?:details");
    expect(hint).toContain("q:quit");
  });

  test("progress shows Starting Koi", () => {
    const hint = getViewCommands("progress").footerHint;
    expect(hint).toContain("Starting Koi");
  });
});

describe("getPaletteCommands", () => {
  test("returns grouped commands", () => {
    const groups = getPaletteCommands({
      capabilities: {
        temporal: true,
        scheduler: true,
        taskboard: true,
        harness: true,
        forge: true,
        gateway: true,
        nexus: true,
        governance: true,
      },
      sessionCount: 100,
    });
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(typeof group.category).toBe("string");
      expect(group.commands.length).toBeGreaterThan(0);
    }
  });

  test("filters by capability", () => {
    const groups = getPaletteCommands({
      capabilities: {
        temporal: false,
        scheduler: false,
        taskboard: false,
        harness: false,
        forge: false,
        gateway: false,
        nexus: false,
        governance: false,
      },
      sessionCount: 100,
    });
    const allIds = groups.flatMap((g) => g.commands.map((c) => c.id));
    expect(allIds).not.toContain("temporal");
    expect(allIds).not.toContain("governance");
    expect(allIds).toContain("agents");
  });

  test("filters by session count", () => {
    const earlyGroups = getPaletteCommands({
      capabilities: null,
      sessionCount: 1,
    });
    const earlyIds = earlyGroups.flatMap((g) => g.commands.map((c) => c.id));
    expect(earlyIds).toContain("agents");
    expect(earlyIds).toContain("dispatch");
    expect(earlyIds).not.toContain("debug");
    expect(earlyIds).not.toContain("governance");

    const laterGroups = getPaletteCommands({
      capabilities: null,
      sessionCount: 100,
    });
    const laterIds = laterGroups.flatMap((g) => g.commands.map((c) => c.id));
    expect(laterIds).toContain("debug");
  });

  test("includes recent section when provided", () => {
    const groups = getPaletteCommands({
      capabilities: null,
      sessionCount: 100,
      recentCommandIds: ["agents", "dispatch"],
    });
    expect(groups[0]?.category).toBe("RECENT");
    expect(groups[0]?.commands.map((c) => c.id)).toEqual(["agents", "dispatch"]);
  });

  test("skips recent section when empty", () => {
    const groups = getPaletteCommands({
      capabilities: null,
      sessionCount: 100,
      recentCommandIds: [],
    });
    expect(groups[0]?.category).not.toBe("RECENT");
  });

  test("null capabilities hides capability-gated commands", () => {
    const groups = getPaletteCommands({
      capabilities: null,
      sessionCount: 100,
    });
    const allIds = groups.flatMap((g) => g.commands.map((c) => c.id));
    expect(allIds).not.toContain("temporal");
    expect(allIds).not.toContain("governance");
    expect(allIds).not.toContain("gateway");
  });
});

describe("no shortcut conflicts within views", () => {
  test("each view has unique shortcuts", () => {
    for (const [view, entry] of Object.entries(VIEW_COMMAND_MAP)) {
      const shortcuts = entry.commands
        .filter((c: CommandMeta) => c.shortcut !== undefined)
        .map((c: CommandMeta) => c.shortcut);
      const unique = new Set(shortcuts);
      if (unique.size !== shortcuts.length) {
        throw new Error(`View "${view}" has duplicate shortcuts: ${JSON.stringify(shortcuts)}`);
      }
    }
  });
});
