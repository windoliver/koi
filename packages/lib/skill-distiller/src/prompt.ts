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

export function renderDistillationPrompt(trace: DistillationTrace): string {
  const turns = trace.turns.map(summarizeTurn).join("\n");
  return `${SYSTEM_INSTRUCTIONS}\n\nTRACE id=${trace.traceId} turns=${trace.turns.length}\n${turns}\n\nReturn the JSON now.`;
}
