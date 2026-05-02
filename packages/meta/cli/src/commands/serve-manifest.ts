import { loadManifestConfig, type ManifestConfig } from "../manifest.js";

export type ManifestConfigLoader = typeof loadManifestConfig;

type ServeManifestResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export async function requireServeManifestConfig(
  manifestPath: string,
  loadConfig?: ManifestConfigLoader,
): Promise<ManifestConfig> {
  const manifest = await loadServeManifestConfig(manifestPath, loadConfig);
  if (!manifest.ok) throw new Error(manifest.error);
  return manifest.value;
}

export async function loadServeManifestConfig(
  manifestPath: string,
  loadConfig: ManifestConfigLoader = loadManifestConfig,
): Promise<ServeManifestResult<ManifestConfig>> {
  const manifestResult = await loadConfig(manifestPath, {
    skipAuditValidation: true,
  });
  if (!manifestResult.ok) {
    return { ok: false, error: `invalid manifest - ${manifestResult.error}` };
  }
  const unsupported = unsupportedServeManifestFields(manifestResult.value);
  if (unsupported.length > 0) {
    return {
      ok: false,
      error:
        "manifest fields are not supported by koi serve yet: " +
        `${unsupported.join(", ")}. Remove them or run this manifest with a host that honors them.`,
    };
  }
  return { ok: true, value: manifestResult.value };
}

function unsupportedServeManifestFields(manifest: ManifestConfig): readonly string[] {
  const fields: string[] = [];
  if (manifest.backgroundSubprocesses === true) fields.push("backgroundSubprocesses");
  if (manifest.filesystem !== undefined) fields.push("filesystem");
  if (manifest.governance !== undefined) fields.push("governance");
  if (manifest.audit !== undefined) fields.push("audit");
  if (manifest.network !== undefined) fields.push("network");
  if (manifest.credentials !== undefined) fields.push("credentials");
  if (manifest.delegation !== undefined) fields.push("delegation");
  if (manifest.supervision !== undefined) fields.push("supervision");
  if (manifest.ace?.enabled === true) fields.push("ace.enabled");
  return fields;
}
