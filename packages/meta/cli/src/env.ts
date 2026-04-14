/**
 * API configuration resolved from environment variables.
 *
 * Shared by `koi tui` and `koi start` so both commands behave identically
 * when selecting the model provider from env vars.
 */

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface ApiConfig {
  readonly apiKey: string;
  /** Base URL for the model provider. Undefined = use adapter's built-in default (OpenRouter). */
  readonly baseUrl: string | undefined;
  readonly model: string;
  /** Resolved provider: "openrouter" when OPENROUTER_API_KEY is set, "openai" otherwise. */
  readonly provider: "openrouter" | "openai";
  /**
   * Ordered fallback models. When non-empty, a model-router is installed with
   * `model` as the primary target and these as the fallback chain.
   * Set via KOI_FALLBACK_MODEL (comma-separated for multiple).
   * All targets share the same apiKey and baseUrl.
   */
  readonly fallbackModels: readonly string[];
}

/**
 * Resolve API configuration from environment variables.
 *
 * Priority:
 *   OPENROUTER_API_KEY → OpenRouter (no explicit base URL needed).
 *   OPENAI_API_KEY only → OpenAI (injects https://api.openai.com/v1).
 *   OPENAI_BASE_URL or OPENROUTER_BASE_URL → override base URL regardless of key source.
 *   KOI_MODEL → override model name (default: google/gemini-2.0-flash-001).
 *
 * Returns `{ ok: false }` when no API key is found.
 * Pass a custom `env` for testing without touching process.env.
 */
export function resolveApiConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
):
  | { readonly ok: true; readonly value: ApiConfig }
  | { readonly ok: false; readonly error: string } {
  const openRouterKey = env.OPENROUTER_API_KEY;
  const openAiKey = env.OPENAI_API_KEY;

  const hasOpenRouter = openRouterKey !== undefined && openRouterKey !== "";
  const hasOpenAi = openAiKey !== undefined && openAiKey !== "";

  const apiKey = hasOpenRouter ? openRouterKey : hasOpenAi ? openAiKey : undefined;
  if (apiKey === undefined) {
    return {
      ok: false,
      error: "no API key found — set OPENROUTER_API_KEY or OPENAI_API_KEY",
    };
  }

  const rawModel = env.KOI_MODEL;
  const model = rawModel !== undefined && rawModel.trim().length > 0 ? rawModel : DEFAULT_MODEL;

  const rawFallback = env.KOI_FALLBACK_MODEL;
  const fallbackModels: readonly string[] =
    rawFallback !== undefined && rawFallback.trim().length > 0
      ? rawFallback
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  // Explicit base URL override takes precedence over provider default.
  const explicitBaseUrl = env.OPENAI_BASE_URL ?? env.OPENROUTER_BASE_URL;
  const validExplicit =
    explicitBaseUrl !== undefined && explicitBaseUrl.trim().length > 0
      ? explicitBaseUrl
      : undefined;
  // OpenRouter adapter has its own built-in default; OpenAI requires an explicit URL.
  const providerDefault = hasOpenRouter ? undefined : OPENAI_DEFAULT_BASE_URL;
  const baseUrl = validExplicit ?? providerDefault;

  const provider = hasOpenRouter ? ("openrouter" as const) : ("openai" as const);
  return { ok: true, value: { apiKey, baseUrl, model, provider, fallbackModels } };
}
