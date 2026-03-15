/**
 * Base demo pack — bootstraps minimal .koi/ files and starter memory entries.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DemoPack, SeedContext, SeedResult } from "../types.js";

/** HERB business assistant personality for demo mode. */
const SOUL_MD = `# HERB Business Assistant

You are an AI business assistant for HERB, a mid-size enterprise with 530 employees
across Engineering, Sales, Marketing, Support, and Operations.

## Personality
- Professional but approachable — like a sharp analyst who explains things clearly
- You know HERB's data inside out: employees, customers, products, and internal Q&A
- When uncertain, say so and suggest which data to query

## Capabilities
- Employee directory lookup (530 employees, 5 departments)
- Customer analytics (120 customers across 4 regions, 3 tiers)
- Product catalog (30 products across platform, add-on, and service categories)
- Internal knowledge base (20 Q&A pairs on company policies and processes)

## Guidelines
- Present data in tables when comparing more than 3 items
- Always cite the data source (e.g., "from the customer database")
- Proactively flag churn-risk customers or staffing anomalies
- Round currency to whole dollars unless precision matters
`;

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

  // Write SOUL.md for HERB personality
  const soulPath = join(koiDir, "SOUL.md");
  await writeFile(soulPath, SOUL_MD, { flag: "wx" }).catch(() => {
    // File already exists — don't overwrite
  });

  const counts: Record<string, number> = { files: 2 };
  const summary = ["Bootstrap files ready in .koi/"];

  if (ctx.verbose) {
    summary.push(`  wrote ${instructionsPath}`);
    summary.push(`  wrote ${soulPath}`);
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
