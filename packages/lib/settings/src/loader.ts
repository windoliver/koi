/**
 * Cascade loader for @koi/settings.
 *
 * Loads up to 5 ordered layers (user → project → local → flag → policy),
 * merges them with scalar-last-wins / array-concat-dedup / deep-object-merge,
 * and applies the policy enforcement pass last.
 *
 * Failure modes:
 *   - Missing file → silently skipped (no error)
 *   - Parse/schema error in non-policy layer → collected in `errors`, layer skipped
 *   - Parse/schema error in policy layer → throws (fail-closed)
 */
import { readFileSync } from "node:fs";
import { mergeSettings } from "./merge.js";
import { resolveSettingsPaths } from "./paths.js";
import { validateKoiSettings, validatePolicySettings } from "./schema.js";
import type {
  KoiSettings,
  SettingsLayer,
  SettingsLoadOptions,
  SettingsLoadResult,
  ValidationError,
} from "./types.js";

const ALL_LAYERS: readonly SettingsLayer[] = [
  "user",
  "project",
  "local",
  "flag",
  "policy",
] as const;

/**
 * Load and merge settings from up to 5 layers.
 *
 * Missing files are silently skipped. Parse/schema errors in non-policy layers
 * are collected in `errors` and the layer is skipped. Policy errors throw so the
 * caller can exit with a non-zero code (fail-closed). The flag layer also throws
 * when `flagPath` was explicitly supplied — an unreadable or invalid explicit
 * settings file should abort startup rather than silently lose the operator's
 * intended restrictions.
 */
export async function loadSettings(opts: SettingsLoadOptions = {}): Promise<SettingsLoadResult> {
  const paths = resolveSettingsPaths(opts);
  const layers = opts.layers ?? ALL_LAYERS;

  // Policy always fatal; flag is fatal only when the operator explicitly passed
  // --settings (i.e. flagPath is set), so a bad path fails closed.
  const fatalLayers = new Set<SettingsLayer>(["policy"]);
  if (opts.flagPath !== undefined) fatalLayers.add("flag");

  const errors: ValidationError[] = [];

  // Build per-layer results immutably
  const layerResults = layers.flatMap((layer): [SettingsLayer, KoiSettings][] => {
    const filePath = paths[layer];
    if (filePath == null) return [];
    const parsed = readSettingsFile(filePath, layer, errors, fatalLayers.has(layer));
    if (parsed == null) return [];
    return [[layer, parsed]];
  });

  const sources: Record<SettingsLayer, KoiSettings | null> = {
    user: null,
    project: null,
    local: null,
    flag: null,
    policy: null,
    ...Object.fromEntries(layerResults),
  };

  const nonPolicySettings = layerResults
    .filter(([layer]) => layer !== "policy")
    .map(([, settings]) => settings);

  const policySettings = layerResults.find(([layer]) => layer === "policy")?.[1] ?? null;

  const settings = mergeSettings(nonPolicySettings, policySettings);

  return { settings, errors, sources };
}

function readSettingsFile(
  filePath: string,
  layer: SettingsLayer,
  errors: ValidationError[],
  isFatal: boolean,
): KoiSettings | null {
  const layerLabel = layer === "policy" ? "Policy settings file" : "Settings file";
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (e: unknown) {
    if (isENOENT(e)) {
      // Policy ENOENT = not installed — silent, return null.
      // Flag ENOENT = operator pointed to a missing file — fatal.
      if (isFatal && layer !== "policy") {
        throw new Error(`${layerLabel} "${filePath}" not found`, { cause: e });
      }
      return null;
    }
    if (isFatal) throw e;
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ file: filePath, path: "", message: `Failed to read file: ${message}` });
    return null;
  }

  if (raw.trim() === "") {
    // Fatal layers (policy, explicit --settings) must never silently produce
    // empty settings from a blank file — a truncated policy file during
    // deployment would otherwise disable all enforcement without any signal.
    if (isFatal) {
      throw new Error(`${layerLabel} "${filePath}" is empty`);
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (isFatal) {
      throw new Error(`${layerLabel} at ${filePath} contains invalid JSON — ${message}`, {
        cause: e,
      });
    }
    errors.push({ file: filePath, path: "", message: `Invalid JSON: ${message}` });
    return null;
  }

  // Policy layer uses strict validation (unknown keys rejected) so admins
  // cannot believe an unsupported key like disabledMcpServers is enforced.
  const result = isFatal ? validatePolicySettings(parsed) : validateKoiSettings(parsed);
  if (!result.ok) {
    if (isFatal) {
      throw new Error(
        `${layerLabel} at ${filePath} failed schema validation — ${result.error.message}`,
        { cause: result.error },
      );
    }
    errors.push({ file: filePath, path: "", message: result.error.message });
    return null;
  }

  return result.value;
}

function isENOENT(e: unknown): boolean {
  return e instanceof Error && "code" in e && Reflect.get(e, "code") === "ENOENT";
}
