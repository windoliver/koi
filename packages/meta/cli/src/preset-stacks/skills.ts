/**
 * Skills preset stack — on-demand skill loading via the Skill meta-tool.
 *
 * Only contributes the `Skill` tool provider when the host supplied a
 * `SkillsRuntime` in the activation context's `host` bag. Hosts without
 * a skills runtime (e.g. plain `koi start`) silently get an empty
 * contribution rather than a hard error — matches the prior inline
 * behavior.
 *
 * The skills runtime is passed through `ctx.host["skillsRuntime"]`
 * rather than a first-class field on `StackActivationContext` because
 * it's a TUI-specific concept; the context stays host-neutral and
 * only this stack knows how to read it.
 */

import { createSingleToolProvider } from "@koi/core";
import { createSkillTool } from "@koi/skill-tool";
import type { SkillsRuntime } from "@koi/skills-runtime";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

/** Key under `StackActivationContext.host` for the skills runtime pointer. */
export const SKILLS_RUNTIME_HOST_KEY = "skillsRuntime";

export const skillsStack: PresetStack = {
  id: "skills",
  description: "On-demand skill loading via the `Skill` meta-tool (requires a SkillsRuntime)",
  activate: async (ctx): Promise<StackContribution> => {
    const skillsRuntime = ctx.host?.[SKILLS_RUNTIME_HOST_KEY] as SkillsRuntime | undefined;
    if (skillsRuntime === undefined) {
      return { middleware: [], providers: [] };
    }
    // AbortController for skill loading — lives for the stack's lifetime.
    // Not rotated on session reset (skill loading is stateless file reads).
    const abortController = new AbortController();
    const skillToolResult = await createSkillTool({
      resolver: skillsRuntime,
      signal: abortController.signal,
    });
    if (!skillToolResult.ok) {
      return { middleware: [], providers: [] };
    }
    const skillTool = skillToolResult.value;
    return {
      middleware: [],
      providers: [
        createSingleToolProvider({
          name: "skill",
          toolName: "Skill",
          createTool: () => skillTool,
        }),
      ],
    };
  },
};
