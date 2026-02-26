/**
 * Soul directory resolution — reads structured SOUL.md + STYLE.md + INSTRUCTIONS.md directories.
 */

import { join } from "node:path";
import { readBoundedFile } from "./read.js";

/** Files to look for in a soul directory, in order. */
export const SOUL_DIR_FILES = ["SOUL.md", "STYLE.md", "INSTRUCTIONS.md"] as const;

/** Section headers for directory mode concatenation. */
export const SECTION_HEADERS: Readonly<Record<string, string>> = {
  "SOUL.md": "## Soul",
  "STYLE.md": "## Style",
  "INSTRUCTIONS.md": "## Instructions",
} as const;

/** Result of resolving a soul directory. */
export interface ResolvedDirectory {
  readonly text: string;
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Resolves directory content by reading SOUL.md (required) and optional STYLE.md, INSTRUCTIONS.md.
 * Returns concatenated sections with headers, or empty text if SOUL.md is missing.
 */
export async function resolveDirectoryContent(
  dirPath: string,
  label: string,
): Promise<ResolvedDirectory> {
  const warnings: string[] = [];
  const sources: string[] = [];
  const sections: string[] = [];

  // SOUL.md is required
  const soulPath = join(dirPath, "SOUL.md");
  const soulContent = await readBoundedFile(soulPath);
  if (soulContent === undefined) {
    return {
      text: "",
      sources: [],
      warnings: [`${label} directory missing required SOUL.md: ${dirPath}`],
    };
  }

  if (soulContent.length === 0) {
    warnings.push(`${label} SOUL.md is empty: ${soulPath}`);
  }

  sources.push(soulPath);
  sections.push(`${SECTION_HEADERS["SOUL.md"]}\n${soulContent}`);

  // Optional files
  for (const fileName of SOUL_DIR_FILES.slice(1)) {
    const filePath = join(dirPath, fileName);
    const content = await readBoundedFile(filePath);
    if (content !== undefined) {
      sources.push(filePath);
      if (content.length > 0) {
        sections.push(`${SECTION_HEADERS[fileName]}\n${content}`);
      } else {
        warnings.push(`${label} ${fileName} is empty: ${filePath}`);
      }
    }
  }

  return { text: sections.join("\n\n"), sources, warnings };
}
