/**
 * CLI dispatch logic (shared between bin.ts and bench-entry.ts).
 *
 * Everything that happens *after* the raw-argv fast-path in bin.ts
 * lives here: args.js load, parseArgs, help/version/no-command
 * short-circuits, TUI detection, registry load, command loader, the
 * justified CommandModule cast. bin.ts dynamically imports this
 * module and calls `runDispatch(rawArgv)`. bench-entry.ts imports
 * the same module and calls the same function for the
 * startup-latency `command-dispatch` scenario.
 *
 * Because both entry points go through **the same function**, the
 * benchmark cannot silently drift away from the shipped dispatch
 * path — any change to bin.ts's dispatch automatically changes the
 * measurement too. This replaces the earlier token-presence parity
 * check, which could not detect control-flow changes.
 *
 * Fast-path exit conditions (--version, --help on raw argv) MUST
 * stay in bin.ts, at the top of the file, before any `import`
 * statement — ESM hoists static imports, so the fast-path would not
 * be fast if it lived here. Those checks are cheap to re-run once
 * (bench-entry.ts does) so they stay outside this helper.
 */

import {
  type CliFlags,
  COMMAND_NAMES,
  isKnownCommand,
  isStartFlags,
  isTuiFlags,
  type KnownCommand,
  ParseError,
  parseArgs,
  type TuiFlags,
} from "./args.js";
import { resolveApiConfig } from "./env.js";
import { resolveManifestPath } from "./resolve-manifest-path.js";
import type { CommandModule } from "./types.js";

/**
 * Outcome of running the dispatch pipeline. bin.ts consumes this and
 * decides whether to call `mod.run(flags)`; bench-entry.ts consumes
 * it too but always exits after receiving the module.
 */
export type DispatchResult =
  | {
      readonly kind: "exit";
      readonly code: number;
      readonly stdout?: string;
      readonly stderr?: string;
    }
  | { readonly kind: "tui-reexec" }
  | { readonly kind: "tui"; readonly flags: TuiFlags }
  | { readonly kind: "run"; readonly mod: CommandModule; readonly flags: CliFlags };

type CommandLoaderMap = Readonly<Partial<Record<KnownCommand, () => Promise<unknown>>>>;
const MANIFEST_REQUIRED_COMMANDS = new Set<KnownCommand>([
  "serve",
  "logs",
  "status",
  "stop",
  "deploy",
]);

function formatThrownMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e !== null && typeof e === "object" && "message" in e) {
    const message = (e as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function noManifestMessage(searched: readonly string[]): string {
  const tried =
    searched.length > 0 ? `\n  Searched:\n${searched.map((p) => `    ${p}`).join("\n")}` : "";
  return `no koi.yaml found — pass --manifest <path>, create one with koi init, or pass --no-manifest to run with built-in defaults${tried}`;
}

function preflightStart(flags: CliFlags): DispatchResult | undefined {
  if (!isStartFlags(flags)) return undefined;
  if (flags.dryRun) {
    return {
      kind: "exit",
      code: 2,
      stderr: "koi start: --dry-run is not yet supported (tracking: #1264)\n",
    };
  }
  if (flags.logFormat === "json") {
    return {
      kind: "exit",
      code: 2,
      stderr: "koi start: --log-format json is not yet supported (tracking: #1264)\n",
    };
  }

  const skipManifestDiscovery =
    flags.noManifest || (flags.resume !== undefined && flags.manifest === undefined);
  const manifest = resolveManifestPath(process.cwd(), flags.manifest, skipManifestDiscovery);
  if (!manifest.ok) {
    return { kind: "exit", code: 2, stderr: `koi start: ${manifest.error}\n` };
  }
  if (manifest.path === undefined && flags.manifest === undefined && !skipManifestDiscovery) {
    return {
      kind: "exit",
      code: 2,
      stderr: `koi start: ${noManifestMessage(manifest.searched)}\n`,
    };
  }

  const apiConfig = resolveApiConfig();
  if (!apiConfig.ok) {
    return { kind: "exit", code: 2, stderr: `koi start: ${apiConfig.error}\n` };
  }
  return undefined;
}

function preflightManifestRequired(flags: CliFlags): DispatchResult | undefined {
  if (!isKnownCommand(flags.command) || !MANIFEST_REQUIRED_COMMANDS.has(flags.command)) {
    return undefined;
  }
  const manifestFlag = "manifest" in flags ? flags.manifest : undefined;
  const manifest = resolveManifestPath(process.cwd(), manifestFlag, false);
  if (!manifest.ok) {
    return { kind: "exit", code: 2, stderr: `koi ${flags.command}: ${manifest.error}\n` };
  }
  if (manifest.path === undefined && manifestFlag === undefined) {
    return {
      kind: "exit",
      code: 2,
      stderr: `koi ${flags.command}: ${noManifestMessage(manifest.searched)}\n`,
    };
  }
  return undefined;
}

async function preflightTuiManifest(flags: TuiFlags): Promise<DispatchResult | undefined> {
  const skipManifestDiscovery =
    flags.noManifest || (flags.resume !== undefined && flags.manifest === undefined);
  const manifest = resolveManifestPath(process.cwd(), flags.manifest, skipManifestDiscovery);
  if (!manifest.ok) {
    return { kind: "exit", code: 1, stderr: `koi tui: ${manifest.error}\n` };
  }
  if (manifest.path === undefined) return undefined;

  const { loadManifestConfig } = await import("./manifest.js");
  const manifestResult = await loadManifestConfig(manifest.path, {
    allowOAuthSchemes: true,
    skipAuditValidation: false,
    skipAuditValidationFor: {
      ndjson: process.env.KOI_AUDIT_NDJSON !== undefined,
      sqlite: process.env.KOI_AUDIT_SQLITE !== undefined,
      violations: !flags.governance.enabled || process.env.KOI_AUDIT_VIOLATIONS !== undefined,
    },
  });
  if (!manifestResult.ok) {
    return {
      kind: "exit",
      code: 1,
      stderr: `koi tui: invalid manifest — ${manifestResult.error}\n`,
    };
  }
  return undefined;
}

/**
 * Parse rawArgv, apply the short-circuit checks, and (for known
 * commands) load the command module. Does **not** call
 * `mod.run(flags)` — that's the caller's job, so that bench-entry can
 * stop before the command body executes.
 *
 * Callers must have already cleared the raw-argv fast-path
 * (--version / --help). This function assumes rawArgv is the post-fast-path
 * argv tail.
 */
export async function runDispatch(
  rawArgv: readonly string[],
  helpText: string,
  version: string,
  commandLoaders?: CommandLoaderMap,
): Promise<DispatchResult> {
  let flags: CliFlags;
  try {
    flags = parseArgs(rawArgv);
  } catch (e: unknown) {
    if (e instanceof ParseError) {
      return { kind: "exit", code: 1, stderr: `error: ${e.message}\n` };
    }
    throw e;
  }

  // --version takes precedence over --help (matches the bin.ts fast-path
  // order and the POSIX convention of exiting on --version first).
  if (flags.version) {
    return { kind: "exit", code: 0, stdout: `${version}\n` };
  }
  if (flags.help) {
    if (isKnownCommand(flags.command)) {
      // Lazy import so the 200-line COMMAND_HELP table stays off the
      // cold-start path measured by the startup-latency benchmark.
      const { COMMAND_HELP } = await import("./help.js");
      return { kind: "exit", code: 0, stdout: COMMAND_HELP[flags.command] };
    }
    return { kind: "exit", code: 0, stdout: helpText };
  }
  if (flags.command === undefined) {
    return { kind: "exit", code: 0, stdout: helpText };
  }

  if (isTuiFlags(flags)) {
    const manifestPreflight = await preflightTuiManifest(flags);
    if (manifestPreflight !== undefined) return manifestPreflight;

    // TUI has a re-exec dance for solid-js's export-condition quirk.
    // bin.ts handles the re-exec; bench-entry.ts should not benchmark
    // the TUI path (we measure `koi start`, not `koi tui`). Return a
    // discriminated result so callers can route appropriately.
    if (process.env.KOI_TUI_BROWSER_SOLID !== "1") {
      return { kind: "tui-reexec" };
    }
    if (process.stdin.isTTY !== true) {
      return { kind: "exit", code: 1, stderr: "koi tui requires a TTY\n" };
    }
    return { kind: "tui", flags };
  }

  if (isKnownCommand(flags.command)) {
    const early = preflightStart(flags) ?? preflightManifestRequired(flags);
    if (early !== undefined) return early;

    const registryLoaders = commandLoaders ?? (await import("./registry.js")).COMMAND_LOADERS;
    const loader = registryLoaders[flags.command];
    if (loader === undefined) {
      return {
        kind: "exit",
        code: 2,
        stderr: `koi ${flags.command}: missing command module loader\n`,
      };
    }
    let mod: CommandModule;
    try {
      // Justified cast: loader returns CommandModule<XxxFlags>, but flags
      // is CliFlags. Safe because the parser produced the correct flag
      // type for this command. Single cast site.
      mod = (await loader()) as CommandModule;
    } catch (e: unknown) {
      const formatted = formatThrownMessage(e);
      const msg = formatted.length > 0 ? `  ${formatted}\n` : "";
      return {
        kind: "exit",
        code: 2,
        stderr: `koi ${flags.command}: failed to load command module\n${msg}`,
      };
    }
    return { kind: "run", mod, flags };
  }

  let stderr = `Unknown command: ${flags.command}\n\nAvailable commands:\n`;
  for (const name of COMMAND_NAMES) {
    stderr += `  ${name}\n`;
  }
  return { kind: "exit", code: 1, stderr };
}
