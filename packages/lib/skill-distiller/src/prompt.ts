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

Do not include any prose outside the JSON object. Do not wrap in markdown.`;

const MAX_TURN_TEXT_BYTES = 1200;

function summarizeTurn(turn: DistillationTrace["turns"][number], index: number): string {
  const role = turn.role.toUpperCase();
  const text =
    turn.text === undefined
      ? ""
      : turn.text.length > MAX_TURN_TEXT_BYTES
        ? `${turn.text.slice(0, MAX_TURN_TEXT_BYTES)}…`
        : turn.text;
  const tools =
    turn.toolCalls === undefined || turn.toolCalls.length === 0
      ? ""
      : `\n  tools: ${turn.toolCalls.map((c) => c.name).join(", ")}`;
  const body = text === "" ? "(no text)" : text;
  return `[${index}] ${role}: ${body}${tools}`;
}

export function renderDistillationPrompt(trace: DistillationTrace): string {
  const turns = trace.turns.map(summarizeTurn).join("\n");
  return `${SYSTEM_INSTRUCTIONS}\n\nTRACE id=${trace.traceId} turns=${trace.turns.length}\n${turns}\n\nReturn the JSON now.`;
}
