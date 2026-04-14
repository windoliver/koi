/**
 * models.dev pricing integration — live pricing data for 300+ models.
 *
 * Fetches from https://models.dev/api.json at startup, caches to disk
 * with a 5-minute TTL, and falls back to the bundled DEFAULT_PRICING
 * when offline.
 *
 * models.dev format: prices in $/million tokens (we convert to $/token).
 * Cache pricing (cache_read/cache_write) is optional and often missing —
 * our bundled CACHE_OVERRIDES fill the gap for major providers.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelPricing } from "./pricing.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_DIR = join(homedir(), ".koi", "cache");
const CACHE_FILE = join(CACHE_DIR, "models-dev-pricing.json");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Cache pricing that models.dev doesn't reliably provide.
 * These are authoritative values from provider pricing pages.
 * Rates in $/token (NOT $/million).
 */
const CACHE_OVERRIDES: Readonly<
  Record<string, Pick<ModelPricing, "cachedInput" | "cacheCreation">>
> = {
  // Anthropic: cache read = 10% of input, cache write = 125% of input
  "claude-opus-4-6": { cachedInput: 1.5e-6, cacheCreation: 18.75e-6 },
  "claude-sonnet-4-6": { cachedInput: 0.3e-6, cacheCreation: 3.75e-6 },
  "claude-sonnet-4-5": { cachedInput: 0.3e-6, cacheCreation: 3.75e-6 },
  "claude-haiku-4-5": { cachedInput: 0.08e-6, cacheCreation: 1e-6 },
  "claude-3-5-sonnet-20241022": { cachedInput: 0.3e-6, cacheCreation: 3.75e-6 },
  "claude-3-5-haiku-20241022": { cachedInput: 0.08e-6, cacheCreation: 1e-6 },
  // OpenAI: cache read = 50% of input
  "gpt-4o": { cachedInput: 1.25e-6 },
  "gpt-4o-mini": { cachedInput: 0.075e-6 },
  o3: { cachedInput: 5e-6 },
  "o3-mini": { cachedInput: 0.55e-6 },
  "o4-mini": { cachedInput: 0.55e-6 },
  // Google: cache read = ~25% of input
  "gemini-2.5-pro": { cachedInput: 0.315e-6 },
  "gemini-2.5-flash": { cachedInput: 0.0375e-6 },
  "gemini-2.0-flash": { cachedInput: 0.025e-6 },
};

/** Raw model entry from models.dev API. */
interface ModelsDevEntry {
  readonly id: string;
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
  };
}

/** Raw provider entry from models.dev API. */
interface ModelsDevProvider {
  readonly id: string;
  readonly models?: Readonly<Record<string, ModelsDevEntry>>;
}

/**
 * Parse models.dev JSON into a flat pricing table.
 * Converts $/million → $/token and merges cache overrides.
 */
export function parseModelsDevJson(
  providers: readonly ModelsDevProvider[],
): Readonly<Record<string, ModelPricing>> {
  const table: Record<string, ModelPricing> = {};

  for (const provider of providers) {
    if (provider.models === undefined) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.cost === undefined) continue;
      const input = (model.cost.input ?? 0) / 1_000_000;
      const output = (model.cost.output ?? 0) / 1_000_000;
      if (input === 0 && output === 0) continue;

      // models.dev may have cache pricing
      const cacheRead =
        model.cost.cache_read !== undefined ? model.cost.cache_read / 1_000_000 : undefined;
      const cacheWrite =
        model.cost.cache_write !== undefined ? model.cost.cache_write / 1_000_000 : undefined;

      // Merge with our authoritative cache overrides
      const overrides = CACHE_OVERRIDES[modelId];

      const pricing: ModelPricing = {
        input,
        output,
        ...(overrides?.cachedInput !== undefined || cacheRead !== undefined
          ? { cachedInput: overrides?.cachedInput ?? cacheRead }
          : {}),
        ...(overrides?.cacheCreation !== undefined || cacheWrite !== undefined
          ? { cacheCreation: overrides?.cacheCreation ?? cacheWrite }
          : {}),
      };

      // Don't overwrite if we already have this model from another provider
      // (first provider wins — typically the canonical one)
      if (table[modelId] === undefined) {
        table[modelId] = pricing;
      }
    }
  }

  return table;
}

/**
 * Read cached pricing from disk. Returns undefined if stale or missing.
 */
async function readDiskCache(): Promise<Readonly<Record<string, ModelPricing>> | undefined> {
  try {
    const file = Bun.file(CACHE_FILE);
    if (!(await file.exists())) return undefined;

    const stat = await file.stat();
    if (stat === null) return undefined;
    const age = Date.now() - stat.mtimeMs;
    if (age > CACHE_TTL_MS) return undefined;

    const raw = await file.json();
    return raw as Record<string, ModelPricing>;
  } catch {
    return undefined;
  }
}

/**
 * Write pricing table to disk cache.
 */
async function writeDiskCache(table: Readonly<Record<string, ModelPricing>>): Promise<void> {
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(CACHE_DIR, { recursive: true });
    await Bun.write(CACHE_FILE, JSON.stringify(table));
  } catch {
    // Disk write failure is non-fatal — next startup will re-fetch
  }
}

/**
 * Fetch live pricing from models.dev, with disk cache and bundled fallback.
 *
 * Priority: disk cache (5-min TTL) → live fetch → bundled DEFAULT_PRICING.
 * Non-blocking: returns bundled pricing immediately if fetch fails.
 */
export async function fetchModelPricing(): Promise<Readonly<Record<string, ModelPricing>>> {
  // 1. Try disk cache
  const cached = await readDiskCache();
  if (cached !== undefined) return cached;

  // 2. Fetch live
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return {};

    const providers = (await response.json()) as readonly ModelsDevProvider[];
    const table = parseModelsDevJson(providers);
    void writeDiskCache(table);
    return table;
  } catch {
    return {};
  }
}
