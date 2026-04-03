/**
 * Custom agent loader — discovers and parses .md agent definitions from directories.
 *
 * Scans two directories (project-level and user-level) with flat glob.
 * Permissive on structure (missing dir = empty), strict on content (parse failures
 * produce warnings + source-aware poisoning to prevent silent fallback).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, AgentDefinitionSource, KoiError } from "@koi/core";

import { parseFrontmatter } from "./frontmatter.js";
import { parseAgentDefinition } from "./parse-agent-definition.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Warning produced when a file fails to parse or read. */
export interface AgentLoadWarning {
  readonly filePath: string;
  readonly error: KoiError;
}

/** A failed agent type with its source tier for priority-aware poisoning. */
export interface FailedAgentType {
  readonly agentType: string;
  readonly source: AgentDefinitionSource;
}

/** Configuration for custom agent loading. */
export interface LoadAgentsConfig {
  /** Project root — scans `<projectDir>/.koi/agents/`. */
  readonly projectDir?: string | undefined;
  /** User home — scans `<userDir>/.koi/agents/`. */
  readonly userDir?: string | undefined;
}

/** Result of loading custom agents. */
export interface LoadAgentsResult {
  readonly agents: readonly AgentDefinition[];
  readonly warnings: readonly AgentLoadWarning[];
  /**
   * Agent types that failed to load, with source tier metadata.
   * Pass to `createAgentDefinitionRegistry()` to prevent silent fallback
   * to lower-priority agents. A failure at source X only blocks definitions
   * at priority < X, not same-or-higher-priority valid definitions.
   */
  readonly failedTypes: readonly FailedAgentType[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Try to extract the intended agent name from frontmatter, even when the
 * full parse pipeline fails. Returns undefined if frontmatter is unparseable.
 */
function extractIntendedName(content: string): string | undefined {
  const fmResult = parseFrontmatter(content);
  if (!fmResult.ok) return undefined;
  const name = fmResult.value.meta.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Derive the intended agent type from content (frontmatter name) or filename. */
function deriveIntendedType(content: string | undefined, filename: string): string {
  if (content !== undefined) {
    const fromFrontmatter = extractIntendedName(content);
    if (fromFrontmatter) return fromFrontmatter;
  }
  return filename.replace(/\.md$/, "");
}

interface DirectoryLoadResult {
  readonly agents: readonly AgentDefinition[];
  readonly warnings: readonly AgentLoadWarning[];
  readonly failedTypes: readonly FailedAgentType[];
}

/**
 * Scan a directory for `.md` files and parse each as an agent definition.
 *
 * - Directory doesn't exist → empty list (no error)
 * - Non-`.md` files → silently ignored
 * - Parse failure → warning + poison intended type (file skipped, others continue)
 * - Read failure → warning + poison filename-derived type
 */
function loadFromDirectory(dir: string, source: AgentDefinitionSource): DirectoryLoadResult {
  if (!existsSync(dir)) {
    return { agents: [], warnings: [], failedTypes: [] };
  }

  const agents: AgentDefinition[] = [];
  const warnings: AgentLoadWarning[] = [];
  const failedTypes: FailedAgentType[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      agents: [],
      warnings: [
        {
          filePath: dir,
          error: {
            code: "INTERNAL",
            message: `Failed to read agents directory "${dir}": ${msg}`,
            retryable: false,
          },
        },
      ],
      failedTypes: [],
    };
  }

  // Sort deterministically — readdirSync order varies across platforms
  entries.sort();

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = join(dir, entry);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      warnings.push({
        filePath,
        error: {
          code: "INTERNAL",
          message: `Failed to read agent file: ${filePath}`,
          retryable: false,
        },
      });
      // Poison on read failure too — can't recover name, use filename
      failedTypes.push({ agentType: entry.replace(/\.md$/, ""), source });
      continue;
    }

    const result = parseAgentDefinition(content, source);
    if (result.ok) {
      agents.push(result.value);
    } else {
      warnings.push({ filePath, error: result.error });
      failedTypes.push({ agentType: deriveIntendedType(content, entry), source });
    }
  }

  return { agents, warnings, failedTypes };
}

/**
 * Load custom agent definitions from project and user directories.
 *
 * Scans `<projectDir>/.koi/agents/` and `<userDir>/.koi/agents/`.
 * Missing directories produce empty results (no error).
 */
export function loadCustomAgents(config: LoadAgentsConfig): LoadAgentsResult {
  const allAgents: AgentDefinition[] = [];
  const allWarnings: AgentLoadWarning[] = [];
  const allFailedTypes: FailedAgentType[] = [];

  // User-level agents (lower priority)
  if (config.userDir) {
    const userAgentsDir = join(config.userDir, ".koi", "agents");
    const { agents, warnings, failedTypes } = loadFromDirectory(userAgentsDir, "user");
    allAgents.push(...agents);
    allWarnings.push(...warnings);
    allFailedTypes.push(...failedTypes);
  }

  // Project-level agents (higher priority)
  if (config.projectDir) {
    const projectAgentsDir = join(config.projectDir, ".koi", "agents");
    const { agents, warnings, failedTypes } = loadFromDirectory(projectAgentsDir, "project");
    allAgents.push(...agents);
    allWarnings.push(...warnings);
    allFailedTypes.push(...failedTypes);
  }

  return { agents: allAgents, warnings: allWarnings, failedTypes: allFailedTypes };
}
