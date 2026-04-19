import type { FetchModelsResult, ModelEntry } from "@koi/tui";

export type { FetchModelsResult };

export interface FetchModelsOptions {
  readonly provider: string;
  readonly baseUrl?: string | undefined;
  readonly apiKey: string;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};

interface RawModel {
  readonly id?: unknown;
  readonly context_length?: unknown;
  readonly pricing?: { readonly prompt?: unknown; readonly completion?: unknown };
}

function parseNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// Model IDs cross a network trust boundary — a malicious or compromised
// provider could return a string containing ANSI / terminal control
// sequences, which would be rendered verbatim in the TUI (status bar,
// picker list, /cost breakdown) and could clobber the user's terminal.
// Accept only the charset real-world model IDs use: alphanumerics plus
// `-_./:` (covering `provider/name`, `name-4.6`, `name:free` variants).
// Cap length so a pathological response cannot fill the status bar.
const MAX_MODEL_ID_LENGTH = 128;
const MODEL_ID_ALLOWED = /^[A-Za-z0-9._:/@-]+$/;

export function sanitizeModelId(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_MODEL_ID_LENGTH) return undefined;
  return MODEL_ID_ALLOWED.test(raw) ? raw : undefined;
}

function normaliseModel(raw: RawModel | null | undefined): ModelEntry | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw.id !== "string") return undefined;
  const safeId = sanitizeModelId(raw.id);
  if (safeId === undefined) return undefined;
  const entry: { -readonly [K in keyof ModelEntry]: ModelEntry[K] } = { id: safeId };
  const ctx = parseNumber(raw.context_length);
  if (ctx !== undefined) entry.contextLength = ctx;
  const pIn = parseNumber(raw.pricing?.prompt);
  if (pIn !== undefined) entry.pricingIn = pIn;
  const pOut = parseNumber(raw.pricing?.completion);
  if (pOut !== undefined) entry.pricingOut = pOut;
  return entry;
}

export async function fetchAvailableModels(
  options: FetchModelsOptions,
): Promise<FetchModelsResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl ?? PROVIDER_DEFAULT_BASE_URLS[options.provider];
  if (base === undefined) {
    return {
      ok: false,
      error: `No /models endpoint known for provider "${options.provider}"`,
    };
  }

  const url = `${base.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const json = (await res.json()) as { data?: readonly RawModel[] };
    const raw = json.data ?? [];
    const models = raw.map(normaliseModel).filter((m): m is ModelEntry => m !== undefined);
    return { ok: true, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}
