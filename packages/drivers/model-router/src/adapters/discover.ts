/**
 * Auto-discovery of local inference servers.
 *
 * Probes well-known local endpoints (Ollama, vLLM, LM Studio) in parallel
 * and returns which providers are running and what models they serve.
 */

const DEFAULT_TIMEOUT_MS = 3_000;

export type LocalProviderKind = "ollama" | "vllm" | "lm-studio";

export interface DiscoveredProvider {
  readonly kind: LocalProviderKind;
  readonly baseUrl: string;
  readonly models: readonly string[];
}

export interface DiscoverOptions {
  readonly timeoutMs?: number | undefined;
  readonly providers?: readonly LocalProviderKind[] | undefined;
}

interface ProviderProfile {
  readonly kind: LocalProviderKind;
  readonly baseUrl: string;
  readonly healthPath: string;
}

const KNOWN_PROFILES: readonly ProviderProfile[] = [
  { kind: "ollama", baseUrl: "http://localhost:11434", healthPath: "/api/tags" },
  { kind: "vllm", baseUrl: "http://localhost:8000", healthPath: "/health" },
  { kind: "lm-studio", baseUrl: "http://localhost:1234", healthPath: "/v1/models" },
] as const;

/**
 * Type guard: narrows unknown to a plain object with string-keyed properties.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extracts model names from an Ollama /api/tags response.
 */
function extractOllamaModels(json: unknown): readonly string[] {
  if (!isRecord(json)) return [];
  const { models } = json;
  if (!Array.isArray(models)) return [];
  return models
    .filter(isRecord)
    .map((m) => m.name)
    .filter((name): name is string => typeof name === "string");
}

/**
 * Extracts model IDs from an OpenAI-compatible /v1/models response.
 */
function extractOpenAIModels(json: unknown): readonly string[] {
  if (!isRecord(json)) return [];
  const { data } = json;
  if (!Array.isArray(data)) return [];
  return data
    .filter(isRecord)
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
}

/**
 * Extracts model names from a health check response based on provider kind.
 */
function extractModels(kind: LocalProviderKind, json: unknown): readonly string[] {
  if (kind === "ollama") return extractOllamaModels(json);
  return extractOpenAIModels(json);
}

/**
 * Probes a single provider endpoint.
 */
async function probeProvider(
  profile: ProviderProfile,
  timeoutMs: number,
): Promise<DiscoveredProvider | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${profile.baseUrl}${profile.healthPath}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return undefined;

    let models: readonly string[] = [];
    try {
      const json: unknown = await response.json();
      models = extractModels(profile.kind, json);
    } catch {
      // vLLM /health returns empty body — models stay empty
    }

    return { kind: profile.kind, baseUrl: profile.baseUrl, models };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discovers locally running inference servers.
 *
 * Probes Ollama, vLLM, and LM Studio in parallel. Returns only healthy
 * providers. The caller decides which adapters to create from the results.
 */
export async function discoverLocalProviders(
  options?: DiscoverOptions,
): Promise<readonly DiscoveredProvider[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const filterSet = options?.providers ? new Set(options.providers) : undefined;

  const profiles = filterSet ? KNOWN_PROFILES.filter((p) => filterSet.has(p.kind)) : KNOWN_PROFILES;

  const results = await Promise.allSettled(
    profiles.map((profile) => probeProvider(profile, timeoutMs)),
  );

  return results
    .map((r) => (r.status === "fulfilled" ? r.value : undefined))
    .filter((p): p is DiscoveredProvider => p !== undefined);
}
