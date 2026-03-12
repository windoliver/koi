/**
 * Base demo pack — bootstraps minimal .koi/ files and starter memory entries.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DemoPack, SeedContext, SeedResult } from "../types.js";

async function seedBase(ctx: SeedContext): Promise<SeedResult> {
  const koiDir = join(ctx.workspaceRoot, ".koi");
  await mkdir(koiDir, { recursive: true });

  // Write a starter INSTRUCTIONS.md if not present
  const instructionsPath = join(koiDir, "INSTRUCTIONS.md");
  const instructions = [
    `# ${ctx.agentName}`,
    "",
    "You are a helpful assistant running in demo mode.",
    "Your memory and search capabilities are pre-seeded with sample data.",
    "",
    "## Operating rules",
    "- Be concise, practical, and honest about uncertainty.",
    "- Use your configured tools and memory to assist the user.",
    "",
  ].join("\n");

  await writeFile(instructionsPath, instructions, { flag: "wx" }).catch(() => {
    // File already exists — don't overwrite
  });

  const counts: Record<string, number> = { files: 1 };
  const summary = ["Bootstrap files ready in .koi/"];

  if (ctx.verbose) {
    summary.push(`  wrote ${instructionsPath}`);
  }

  return { ok: true, counts, summary };
}

export const BASE_PACK: DemoPack = {
  id: "base",
  name: "Base",
  description: "Minimal bootstrap files and starter instructions",
  requires: [],
  agentRoles: [],
  seed: seedBase,
  prompts: ["What can you help me with?", "Describe your capabilities."],
} as const;
