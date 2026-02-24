/**
 * Accessibility-tree serializer for Playwright AccessibilityNode trees.
 *
 * Converts Playwright's AccessibilityNode tree into compact text with
 * [ref=eN] inline markers on interactive elements.
 *
 * ~800 tokens per typical page vs 5000+ for screenshots.
 * Compatible with any LLM — plain text, zero vision required.
 */

import type { BrowserRefInfo, BrowserSnapshotOptions } from "@koi/core";

/**
 * Minimal subset of Playwright's AccessibilityNode that we use.
 * Defined locally to keep the serializer testable with zero Playwright dep.
 */
export interface A11yNode {
  readonly role: string;
  readonly name: string;
  readonly value?: string | number;
  readonly description?: string;
  readonly level?: number;
  readonly checked?: boolean | "mixed";
  readonly pressed?: boolean | "mixed";
  readonly selected?: boolean;
  readonly expanded?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly children?: readonly A11yNode[];
}

/** Roles that receive [ref=eN] markers and can be targeted by interaction tools. */
const INTERACTIVE_ROLES = new Set<string>([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "radiogroup",
  "radio",
  "checkbox",
  "switch",
  "spinbutton",
  "slider",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "tab",
  "treeitem",
  "option",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
]);

export interface SerializeResult {
  readonly text: string;
  readonly refs: Readonly<Record<string, BrowserRefInfo>>;
  readonly truncated: boolean;
}

// 1 token ≈ 4 chars (conservative estimate for structured text)
const CHARS_PER_TOKEN = 4;

/**
 * Serialize an accessibility node tree to compact text with [ref=eN] markers.
 *
 * Output format (example):
 *   WebArea "Page Title"
 *     heading "Section" [level=1]
 *     button "Submit" [ref=e1]
 *     link "Home" [ref=e2]
 *     textbox "Search" [required, ref=e3]
 */
export function serializeA11yTree(
  root: A11yNode,
  options?: BrowserSnapshotOptions,
): SerializeResult {
  const maxTokens = options?.maxTokens ?? 4000;
  const maxDepth = options?.maxDepth ?? 8;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  let refCounter = 0;
  const refs: Record<string, BrowserRefInfo> = {};
  const lines: string[] = [];
  let charCount = 0;
  let truncated = false;

  function visit(node: A11yNode, depth: number): boolean {
    if (truncated) return false;
    if (depth > maxDepth) {
      truncated = true;
      return false;
    }
    if (charCount >= maxChars) {
      truncated = true;
      return false;
    }

    const indent = "  ".repeat(depth);
    const isInteractive = INTERACTIVE_ROLES.has(node.role);

    let line = `${indent}${node.role}`;
    if (node.name) {
      line += ` "${node.name}"`;
    }

    // Collect state attributes
    const attrs: string[] = [];
    if (node.level !== undefined) attrs.push(`level=${node.level}`);
    if (node.value !== undefined) attrs.push(`value="${node.value}"`);
    if (node.checked === true) attrs.push("checked");
    if (node.checked === "mixed") attrs.push("indeterminate");
    if (node.pressed === true) attrs.push("pressed");
    if (node.selected === true) attrs.push("selected");
    if (node.expanded === true) attrs.push("expanded");
    if (node.expanded === false) attrs.push("collapsed");
    if (node.disabled === true) attrs.push("disabled");
    if (node.required === true) attrs.push("required");
    if (node.description) attrs.push(`desc="${node.description}"`);

    if (isInteractive) {
      const refKey = `e${++refCounter}`;
      refs[refKey] = {
        role: node.role,
        ...(node.name ? { name: node.name } : {}),
      };
      attrs.push(`ref=${refKey}`);
    }

    if (attrs.length > 0) {
      line += ` [${attrs.join(", ")}]`;
    }

    // Check if adding this line would exceed the limit
    const lineLen = line.length + 1; // +1 for newline
    if (charCount + lineLen > maxChars) {
      truncated = true;
      return false;
    }

    charCount += lineLen;
    lines.push(line);

    if (node.children) {
      for (const child of node.children) {
        if (!visit(child, depth + 1)) break;
      }
    }

    return true;
  }

  visit(root, 0);

  return {
    text: lines.join("\n"),
    refs,
    truncated,
  };
}
