/**
 * Middleware that auto-promotes skills when referenced in model messages.
 *
 * Scans model request messages for `skill:<name>` references and promotes
 * matching skills to a higher load level. Fire-and-forget — promotion runs
 * concurrently and does not block the model call.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import type { ProgressiveSkillProvider, SkillLoadLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SkillActivatorConfig {
  /** The progressive provider that manages skill levels. */
  readonly provider: ProgressiveSkillProvider;
  /** Target level for auto-promotion. Defaults to provider's configured loadLevel. */
  readonly targetLevel?: SkillLoadLevel;
}

// ---------------------------------------------------------------------------
// Skill reference extraction
// ---------------------------------------------------------------------------

/**
 * Pattern for skill references in text: `skill:<name>`.
 * Skill names follow the Agent Skills Standard: lowercase alphanumeric + hyphens.
 */
const SKILL_REF_PATTERN = /\bskill:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\b/g;

/**
 * Extracts skill names from text and fires promote() for each match.
 * Fire-and-forget — errors are silently ignored (promotion is best-effort).
 */
function promoteMatchesInText(
  text: string,
  provider: ProgressiveSkillProvider,
  targetLevel: SkillLoadLevel,
): void {
  const seen = new Set<string>();
  // let: RegExp.exec requires mutable iteration
  let match = SKILL_REF_PATTERN.exec(text);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined && !seen.has(name) && provider.getLevel(name) !== undefined) {
      seen.add(name);
      void provider.promote(name, targetLevel);
    }
    match = SKILL_REF_PATTERN.exec(text);
  }
  // Reset regex lastIndex for next call (global flag is stateful)
  SKILL_REF_PATTERN.lastIndex = 0;
}

/**
 * Scans all text content blocks in model request messages for skill references
 * and fires promote() for each match. Fire-and-forget.
 */
function promoteReferencedSkills(
  request: ModelRequest,
  provider: ProgressiveSkillProvider,
  targetLevel: SkillLoadLevel,
): void {
  for (const msg of request.messages) {
    for (const block of msg.content) {
      if (block.kind === "text") {
        promoteMatchesInText(block.text, provider, targetLevel);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a middleware that auto-promotes skills referenced in model messages.
 *
 * Intercepts wrapModelCall to scan for `skill:<name>` patterns in message text.
 * Promotion is fire-and-forget — does not block the model call chain.
 */
export function createSkillActivatorMiddleware(config: SkillActivatorConfig): KoiMiddleware {
  const { provider, targetLevel = "body" } = config;

  const wrapModelCall = async (
    _ctx: TurnContext,
    request: ModelRequest,
    next: ModelHandler,
  ): Promise<ModelResponse> => {
    promoteReferencedSkills(request, provider, targetLevel);
    return next(request);
  };

  const describeCapabilities = (_ctx: TurnContext): CapabilityFragment | undefined => {
    return undefined;
  };

  return {
    name: "skill-activator",
    priority: 200,
    wrapModelCall,
    describeCapabilities,
  };
}
