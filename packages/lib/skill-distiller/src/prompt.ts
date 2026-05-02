import type { DistillationTrace } from "./types.js";

export const PROMPT_VERSION = "1";

const SYSTEM_INSTRUCTIONS = `You distill reusable skills from successful task traces.
Read the trace and emit a single JSON object describing the procedure as a
parameterized skill. The output MUST be valid JSON with exactly these fields:

  {
    "name": string,                  // kebab-case, <=40 chars, [a-z0-9-]+
    "description": string,           // single sentence, <=200 chars
    "triggers": string[],            // user-intent phrases that should activate this skill
    "parameters": [{ "name": string, "description": string, "required": boolean }],
    "toolSequence": string[],        // ordered tool names actually invoked
    "expectedInputs": string[],      // what the agent needs from the user
    "expectedOutputs": string[]      // what the user receives at the end
  }

Generalization rules:
- Tool ARGUMENTS that change per invocation (paths, IDs, tenants, scopes,
  destructive targets) MUST be declared as a "parameters" entry, not burned
  into the description or expectedInputs as a literal value.
- toolSequence is the ORDERED procedure. Match the order in the trace.
- If a tool was called against a specific resource (file path, tenant id,
  database name), abstract it through a parameter — never assume the new
  caller wants the same target.

Do not include any prose outside the JSON object. Do not wrap in markdown.`;

const MAX_TURN_TEXT_BYTES = 1200;
const MAX_TOOL_ARGS_BYTES = 400;
// Whole-prompt ceiling. Per-field clipping bounds individual turns, but a
// long valid session can still concatenate to a context-overflowing prompt.
// 32 KiB keeps us well inside any modern provider window with budget left
// for the model's own response, while big enough to fit ~50–100 typical turns.
const MAX_PROMPT_BYTES = 32 * 1024;
const TRUNCATION_NOTICE = "\n  …[trace truncated to fit prompt budget]";

function clip(value: string, maxBytes: number): string {
  return value.length > maxBytes ? `${value.slice(0, maxBytes)}…` : value;
}

function summarizeTurn(turn: DistillationTrace["turns"][number], index: number): string {
  const role = turn.role.toUpperCase();
  const text = turn.text === undefined ? "" : clip(turn.text, MAX_TURN_TEXT_BYTES);
  // Surface tool call arguments — without them the model cannot tell whether a
  // call should be parameterized or treated as a constant.
  const tools =
    turn.toolCalls === undefined || turn.toolCalls.length === 0
      ? ""
      : `\n  tools:\n${turn.toolCalls
          .map((c) => `    - ${c.name}(${clip(c.argsJson, MAX_TOOL_ARGS_BYTES)})`)
          .join("\n")}`;
  const body = text === "" ? "(no text)" : text;
  return `[${index}] ${role}: ${body}${tools}`;
}

// Concatenate turn summaries up to the byte budget. Earliest turns are kept
// (they typically carry the user request and the first tool calls — the
// signal grounding + the leak detector both anchor on); later turns are
// dropped with an explicit truncation notice so the LLM knows the trace was
// elided rather than ended.
function joinTurnsWithinBudget(summaries: readonly string[], budget: number): string {
  // Reserve room for the truncation notice up front so the cap is honored
  // even when we're forced to elide the tail.
  const reserve = TRUNCATION_NOTICE.length + 1; // +1 for the "\n" separator
  const safeBudget = Math.max(0, budget - reserve);
  let used = 0;
  const kept: string[] = [];
  let truncated = false;
  for (const s of summaries) {
    const cost = (kept.length === 0 ? 0 : 1) + s.length;
    if (used + cost > safeBudget) {
      truncated = true;
      break;
    }
    kept.push(s);
    used += cost;
  }
  if (truncated) kept.push(TRUNCATION_NOTICE);
  return kept.join("\n");
}

export interface RenderedPrompt {
  readonly prompt: string;
  /** True if any turn summaries were dropped to fit the byte budget. */
  readonly truncated: boolean;
}

export function renderDistillationPrompt(trace: DistillationTrace): string {
  return renderDistillationPromptDetailed(trace).prompt;
}

export function renderDistillationPromptDetailed(trace: DistillationTrace): RenderedPrompt {
  const summaries = trace.turns.map(summarizeTurn);
  const header = `${SYSTEM_INSTRUCTIONS}\n\nTRACE id=${trace.traceId} turns=${trace.turns.length}\n`;
  const footer = "\n\nReturn the JSON now.";
  const turnsBudget = MAX_PROMPT_BYTES - header.length - footer.length;
  const turns = joinTurnsWithinBudget(summaries, Math.max(0, turnsBudget));
  const truncated = turns.includes(TRUNCATION_NOTICE);
  return { prompt: `${header}${turns}${footer}`, truncated };
}
