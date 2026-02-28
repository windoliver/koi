/**
 * Registry skill component — teaches agents how to use registry tools.
 *
 * Provides a SkillComponent with guidance on search vs browse, trust tier
 * evaluation, and version selection. Attached via skillToken("registry-guide").
 */

import type { SkillComponent } from "@koi/core";

const REGISTRY_SKILL_CONTENT = `# Registry Tools Guide

## When to Search vs Browse
- **Search** (registry_search): Use when you know keywords, tags, or the kind of capability you need
- **Browse** (registry_search with no text): Use to discover what's available, filtered by kind or tags

## Trust Tier Evaluation Before Install
Before using registry_install, evaluate the brick's trust tier:
- **sandbox**: Runs in isolated container. Safe to install for experimentation
- **verified**: Passes verification checks. Suitable for production use
- **promoted**: First-party code. Runs in-process with full privileges

## Version Selection
- Use registry_list_versions to see all available versions before installing
- Prefer the latest non-deprecated version unless a specific version is required
- Check the 'deprecated' flag — deprecated versions work but may have known issues

## Tool Reference
| Tool | Purpose | When to Use |
|------|---------|-------------|
| registry_search | FTS5 search across bricks | Discovering capabilities by keyword/tag |
| registry_get | Get brick details | Evaluating a specific brick before install |
| registry_list_versions | List version history | Choosing which version to install |
| registry_install | Install a brick | Adding a capability to your toolkit |
`;

export function createRegistrySkillComponent(): SkillComponent {
  return {
    name: "registry-guide",
    description: "Guide for using registry tools to discover and install bricks",
    tags: ["registry", "discovery", "install"],
    content: REGISTRY_SKILL_CONTENT,
  };
}
