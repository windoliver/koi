/**
 * Skill component for the handoff tools — teaches agents structured context relay.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const HANDOFF_SKILL_NAME = "handoff" as const;

/**
 * Markdown content teaching agents the handoff workflow.
 * Injected into the agent's context alongside the tool descriptors.
 */
export const HANDOFF_SKILL_CONTENT: string = `
# Handoff — structured context relay between agents

## Overview

Handoff provides a two-tool workflow for packaging and receiving typed envelopes
between pipeline agents. \`prepare_handoff\` creates an envelope with structured
context, and \`accept_handoff\` unpacks it on the receiving end. This enables
reliable, typed agent-to-agent baton passing.

## The two tools

### prepare_handoff — package your work

Create a typed envelope containing:

- **completed**: summary of what you accomplished (required)
- **next**: instructions for the receiving agent (required)
- **to**: target agent ID (provide exactly one of \`to\` or \`capability\`)
- **capability**: resolve target by capability — hand off to the first running agent
  that declares this capability (provide exactly one of \`to\` or \`capability\`)
- **results**: structured data (optional JSON object)
- **artifacts**: references to files, URLs, or other resources (optional)
- **decisions**: record of key decisions made with reasoning (optional)
- **warnings**: pitfalls or caveats the next agent should know about (optional)

The tool returns an envelope ID that the target agent uses to accept the handoff.

### accept_handoff — receive a handoff

Accept an envelope by its ID to get the full context:

- You receive all fields the sender packaged: completed work summary,
  next-step instructions, results, artifacts, decisions, and warnings
- Review the context before proceeding — it replaces any verbal briefing

## When to use handoff

- **Pipeline stages**: agent A completes research, hands off to agent B for implementation
- **Specialist relay**: security reviewer hands off findings to the fixer agent
- **Structured context transfer**: when you need typed, schema-validated data transfer
  rather than free-text messages
- **Audit trail**: handoff envelopes create a record of what was passed and when
- **Capability-based routing**: use \`capability\` instead of \`to\` when you don't know the
  target agent ID but know what capability is needed (e.g., "deployment", "code-review")

## When NOT to use handoff

- **Self-delegation**: if you are spawning a subagent for a task, use \`task\` — handoff is
  for peer-to-peer relay in a pipeline, not parent-child delegation
- **Parallel fan-out**: use \`parallel_task\` for concurrent independent work
- **Simple results**: if you just need to return a string result, a tool response is
  sufficient — handoff is for rich, structured context transfer

## Writing good handoff content

### completed field
- Summarize outcomes, not process: "Identified 3 XSS vulnerabilities in auth module"
  not "I read auth.ts and ran some checks"
- Include key data points and metrics

### next field
- Be specific about what the receiver should do
- Include file paths, function names, and any constraints
- State the expected deliverable

### decisions field
- Record decisions that affect downstream work
- Include reasoning so the receiver understands trade-offs
- Flag decisions that are reversible vs irreversible

### warnings field
- Flag known issues, edge cases, or time-sensitive concerns
- Warn about flaky tests, environment requirements, or permissions needed

## Error handling

- **Handoff not found**: the envelope ID is invalid or expired — verify the ID from the
  prepare step
- **Already accepted**: each envelope can only be accepted once — if you need the data
  again, ask the sender to create a new handoff
- **Validation errors**: required fields (completed, next, and one of to/capability) must be
  provided — check the error message for which field is missing
- **No agent found**: when using \`capability\`, no running agent declares that capability —
  verify the capability string matches the target agent's manifest
`.trim();

/**
 * Pre-built SkillComponent for handoff workflow guidance.
 * Attached automatically by createHandoffProvider alongside the tools.
 */
export const HANDOFF_SKILL: SkillComponent = {
  name: HANDOFF_SKILL_NAME,
  description: "Structured agent-to-agent context relay, envelope packaging, and handoff lifecycle",
  content: HANDOFF_SKILL_CONTENT,
  tags: ["handoff", "pipeline", "context-transfer"],
} as const satisfies SkillComponent;
