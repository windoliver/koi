import type { TranscriptEntry } from "@koi/core";
import type { Focus, Granularity } from "./types.js";

export const PROMPT_VERSION = 3;

export interface BuildPromptInput {
  readonly granularity: Granularity;
  readonly focus: Required<Focus>;
  readonly maxTokens: number;
  readonly hasCompactionPrefix: boolean;
  readonly strictRetry?: boolean;
}

export interface BuiltPrompt {
  readonly system: string;
  readonly user: string;
}

const GRANULARITY_HINT: Record<Granularity, string> = {
  high: "Be terse. Output goal + status + top 3 outcomes only.",
  medium: "List major actions and errors. Skip routine steps.",
  detailed: "List every tool call, every error with its fix, every decision.",
};

const COMPACTION_NOTE =
  "The transcript contains one or more [compaction] entries: these carry a prior model-generated summary of older history, NOT raw transcript facts. Treat compacted prefixes as derived narrative. Prefer evidence from raw entries; when drawing on a compacted prefix, label it in actions / outcomes as derived-from-compaction.";

const STRICT_RETRY_SUFFIX =
  "Output MUST be valid JSON ONLY matching the schema. No prose, no analysis tags, no markdown fences.";

const SCHEMA_SPEC =
  'Schema: {"goal":string,"status":"succeeded"|"partial"|"failed","actions":[{"kind":"tool_call"|"edit"|"decision","name":string,"paths"?:string[],"detail"?:string}],"outcomes":string[],"errors":string[],"learnings":string[]}. All string arrays may be empty. No other top-level fields allowed.';

export function buildPrompt(
  entries: readonly TranscriptEntry[],
  input: BuildPromptInput,
): BuiltPrompt {
  const focusFields = enabledFocusFields(input.focus);
  const system = [
    "You summarize a Koi agent session. Output ONLY a single JSON object matching the schema below — no top-level fields other than the six listed.",
    SCHEMA_SPEC,
    `Emphasize these topics in your summary content: ${describeFocus(focusFields)}.`,
    GRANULARITY_HINT[input.granularity],
    `Stay under ~${input.maxTokens} tokens.`,
    input.hasCompactionPrefix ? COMPACTION_NOTE : "",
    input.strictRetry
      ? STRICT_RETRY_SUFFIX
      : "Return a single JSON object. Scratchpad reasoning may go inside <analysis>…</analysis> and will be stripped.",
  ]
    .filter((s) => s.length > 0)
    .join(" ");

  const user = ["Transcript:", ...entries.map(renderEntry)].join("\n");
  return { system, user };
}

function enabledFocusFields(f: Required<Focus>): readonly string[] {
  const names: readonly (keyof Required<Focus>)[] = [
    "goals",
    "tool_calls",
    "errors",
    "files_changed",
    "decisions",
  ];
  return names.filter((k) => f[k]);
}

const FOCUS_LABELS: Record<string, string> = {
  goals: "user goals",
  tool_calls: "tool invocations",
  errors: "errors encountered",
  files_changed: "files created or edited",
  decisions: "decisions the agent made",
};

function describeFocus(fields: readonly string[]): string {
  return fields.map((f) => FOCUS_LABELS[f] ?? f).join(", ");
}

function renderEntry(e: TranscriptEntry): string {
  return `[${e.role}] ${e.content}`;
}
