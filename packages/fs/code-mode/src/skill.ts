/**
 * Skill component for the code-mode tools — teaches agents the plan-then-apply workflow.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const CODE_MODE_SKILL_NAME = "code-mode" as const;

/**
 * Markdown content teaching agents the code planning workflow.
 * Injected into the agent's context alongside the tool descriptors.
 */
export const CODE_MODE_SKILL_CONTENT: string = `
# Code Mode — structured code generation workflow

## Overview

Code mode provides a two-phase propose/apply workflow for file modifications. You create
a plan describing file edits, creations, deletions, and renames. The system validates the
plan against the filesystem, shows a preview, and then applies it atomically on your command.

## The three tools

### code_plan_create — propose changes

Build a plan with one or more steps:

- **create**: write a new file with full content
- **edit**: modify an existing file with oldText/newText pairs
- **delete**: remove an existing file
- **rename**: move a file from one path to another

The system validates all steps before accepting the plan:
- Files referenced by edit/delete must exist
- Files referenced by create must not exist (unless overwrite is intended)
- Edit oldText must match the current file content exactly
- Staleness detection prevents clobbering concurrent changes

### code_plan_apply — execute the plan

Apply the validated plan atomically. Optionally pass the planId to confirm you are
applying the correct plan. If validation fails at apply time (e.g., file changed since
plan creation), the apply is rejected and you must create a new plan.

### code_plan_status — check plan state

Query the current plan state: pending, applied, or failed. Use this after applying
to confirm success, or to check if a previous plan is still pending.

## When to use code mode

- **Multi-file changes**: edits spanning 2+ files that should land atomically
- **Reviewable changes**: when you want to preview all changes before applying
- **Staleness-sensitive edits**: when files may be modified concurrently and you
  need conflict detection
- **Structured refactoring**: rename + edit combinations that should be atomic

## When NOT to use code mode

- **Single small edit**: for a one-line fix in one file, direct file editing is faster
- **Exploratory changes**: if you are still figuring out what to change, direct edits
  with immediate feedback are more productive
- **Read-only tasks**: code mode is for writes — use file reading tools for analysis

## Workflow best practices

1. **Read before planning**: always read the target files first to get accurate content
   for edit steps (oldText must match exactly)
2. **Keep plans focused**: one logical change per plan — do not bundle unrelated edits
3. **Check status after apply**: confirm the plan was applied successfully
4. **Handle validation errors**: if create fails validation, read the error details —
   common issues are stale content, missing files, or duplicate create paths

## Error handling

- **Stale content**: the file changed between plan creation and apply — re-read the
  file and create a new plan
- **oldText mismatch**: the edit target text does not exist in the file — re-read the
  file to get the correct content
- **File not found**: the target file was deleted or moved — verify the path
- **Plan already applied**: each plan can only be applied once — create a new plan
  for additional changes
`.trim();

/**
 * Pre-built SkillComponent for code mode workflow guidance.
 * Attached automatically by createCodeModeProvider alongside the tools.
 */
export const CODE_MODE_SKILL: SkillComponent = {
  name: CODE_MODE_SKILL_NAME,
  description:
    "Plan-then-apply code generation workflow, step types, validation rules, and staleness handling",
  content: CODE_MODE_SKILL_CONTENT,
  tags: ["code-generation", "planning", "filesystem"],
} as const satisfies SkillComponent;
