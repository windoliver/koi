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
import { validateKoiSettings } from "./schema.js";
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
 * caller can exit with a non-zero code (fail-closed).
 */
export async function loadSettings(opts: SettingsLoadOptions = {}): Promise<SettingsLoadResult> {
  const paths = resolveSettingsPaths(opts);
  const layers = opts.layers ?? ALL_LAYERS;

  const errors: ValidationError[] = [];
  const sources: Record<SettingsLayer, KoiSettings | null> = {
    user: null,
    project: null,
    local: null,
    flag: null,
    policy: null,
  };

  const regularLayers: KoiSettings[] = [];
  let policyLayer: KoiSettings | null = null;

  for (const layer of layers) {
    const filePath = paths[layer];
    if (filePath == null) continue;

    const parsed = readSettingsFile(filePath, layer, errors);
    if (parsed == null) continue;

    sources[layer] = parsed;

    if (layer === "policy") {
      policyLayer = parsed;
    } else {
      regularLayers.push(parsed);
    }
  }

  const settings = mergeSettings(regularLayers, policyLayer);

  return { settings, errors, sources };
}

function readSettingsFile(
  filePath: string,
  layer: SettingsLayer,
  errors: ValidationError[],
): KoiSettings | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (e: unknown) {
    if (isENOENT(e)) return null;
    throw e;
  }

  if (raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (layer === "policy") {
      throw new Error(`Policy settings file at ${filePath} contains invalid JSON — ${message}`, {
        cause: e,
      });
    }
    errors.push({ file: filePath, path: "", message: `Invalid JSON: ${message}` });
    return null;
  }

  const result = validateKoiSettings(parsed);
  if (!result.ok) {
    if (layer === "policy") {
      throw new Error(
        `Policy settings file at ${filePath} failed schema validation — ${result.error.message}`,
        { cause: result.error },
      );
    }
    errors.push({ file: filePath, path: "", message: result.error.message });
    return null;
  }

  return result.value;
}

function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as Record<string, unknown>).code === "ENOENT"
  );
}
