import { z } from "zod";

const ACTION_SCHEMA = z.strictObject({
  kind: z.enum(["tool_call", "edit", "decision"]),
  name: z.string(),
  paths: z.array(z.string()).optional(),
  detail: z.string().optional(),
});

const CONTENT_SCHEMA = z.strictObject({
  goal: z.string(),
  status: z.enum(["succeeded", "partial", "failed"]),
  actions: z.array(ACTION_SCHEMA),
  outcomes: z.array(z.string()),
  errors: z.array(z.string()),
  learnings: z.array(z.string()),
});

export type ParsedContent = z.infer<typeof CONTENT_SCHEMA>;

export interface ParseError {
  readonly reason: string;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedContent }
  | { readonly ok: false; readonly error: ParseError };

export function parseOutput(raw: string): ParseResult {
  const cleaned = stripScratchpad(stripCodeFence(raw.trim()));
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      error: {
        reason: `json_parse: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const result = CONTENT_SCHEMA.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: {
        reason: `schema: ${result.error.issues
          .map((i) => `${i.path.join(".")}:${i.message}`)
          .join(";")}`,
      },
    };
  }
  return { ok: true, value: result.data };
}

function stripCodeFence(s: string): string {
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;
  const m = s.match(fence);
  return m?.[1] ?? s;
}

function stripScratchpad(s: string): string {
  return s.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
}
