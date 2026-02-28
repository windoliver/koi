/**
 * Accessibility-tree serializer for Playwright accessibility snapshots.
 *
 * Two entry-points:
 *  - parseAriaYaml()   — parses Playwright 1.44+ locator.ariaSnapshot() YAML output
 *  - serializeA11yTree() — converts the legacy AccessibilityNode tree format
 *
 * Both produce the same SerializeResult: compact text + refs map with [ref=eN] markers.
 * ~800 tokens per typical page vs 5000+ for screenshots.
 * Compatible with any LLM — plain text, zero vision required.
 */

import type { BrowserRefInfo, BrowserSnapshotOptions } from "@koi/core";
import { CHARS_PER_TOKEN } from "@koi/token-estimator";

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

/**
 * Roles that receive [ref=eN] markers and can be targeted by interaction tools.
 * Also used as the valid AriaRole set for type-safe getByRole() calls.
 */
export const VALID_ROLES: ReadonlySet<string> = new Set<string>([
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

/** Type guard: narrows a string to a valid ARIA role for getByRole(). */
export function isAriaRole(role: string): role is string & { readonly __ariaRole: true } {
  return VALID_ROLES.has(role);
}

export interface SerializeResult {
  readonly text: string;
  readonly refs: Readonly<Record<string, BrowserRefInfo>>;
  readonly truncated: boolean;
  /** Page title extracted from the first document/WebArea node, if present. */
  readonly title?: string;
}

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
  let title: string | undefined;

  // Track occurrence counts for nthIndex: key = "role\0name"
  const occurrenceCount = new Map<string, number>();

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

    // Extract title from root WebArea/document node
    if (depth === 0 && (node.role === "WebArea" || node.role === "document") && node.name) {
      title = node.name;
    }

    const indent = "  ".repeat(depth);
    const isInteractive = VALID_ROLES.has(node.role);

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
      const occKey = `${node.role}\0${node.name ?? ""}`;
      const nthIndex = occurrenceCount.get(occKey) ?? 0;
      occurrenceCount.set(occKey, nthIndex + 1);

      const refKey = `e${++refCounter}`;
      refs[refKey] = {
        role: node.role,
        ...(node.name ? { name: node.name } : {}),
        nthIndex,
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
    ...(title !== undefined ? { title } : {}),
  };
}

/**
 * Parse Playwright 1.44+ ARIA snapshot YAML (from `locator.ariaSnapshot()`) into compact
 * text with [ref=eN] markers — the same format as serializeA11yTree().
 *
 * Input example:
 *   - document "Page Title"
 *   - heading "Example Domain" [level=1]
 *   - paragraph: This domain is for use in examples.
 *   - paragraph:
 *     - link "Learn more" [aria-ref=e12]:
 *       - /url: https://iana.org/domains/example
 *
 * Lines starting with `- /key:` are metadata properties (e.g. /url) and are skipped.
 * Native `aria-ref` attributes from Playwright are captured in BrowserRefInfo.ariaRef.
 */
export function parseAriaYaml(yaml: string, options?: BrowserSnapshotOptions): SerializeResult {
  const maxTokens = options?.maxTokens ?? 4000;
  const maxDepth = options?.maxDepth ?? 8;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  let refCounter = 0;
  const refs: Record<string, BrowserRefInfo> = {};
  const lines: string[] = [];
  let charCount = 0;
  let truncated = false;
  let title: string | undefined;

  // Track occurrence counts for nthIndex: key = "role\0name"
  const occurrenceCount = new Map<string, number>();

  // Matches: `  - role "name" [attrs]: inline-text`
  // Groups: [1]=indent, [2]=role, [3]=name (opt), [4]=attrs (opt), [5]=inline (opt)
  const LINE_RE = /^( *)- ([a-z][\w-]*)(?:\s+"([^"]*)")?(?:\s+\[([^\]]*)\])?(?::\s*(.*))?$/;

  for (const rawLine of yaml.split("\n")) {
    const trimmed = rawLine.trimEnd();
    if (!trimmed.trim()) continue;
    // Skip metadata properties emitted by Playwright like `- /url: ...`
    if (/^ *- \//.test(trimmed)) continue;

    const m = LINE_RE.exec(trimmed);
    if (!m) continue;

    const depth = (m[1]?.length ?? 0) / 2;
    if (depth > maxDepth) {
      truncated = true;
      continue;
    }
    if (charCount >= maxChars) {
      truncated = true;
      break;
    }

    const role = m[2] ?? "";
    const name = m[3] ?? "";
    const rawAttrs = m[4] ?? "";
    const isInteractive = VALID_ROLES.has(role);

    // Extract page title from root document/WebArea node
    if (depth === 0 && (role === "document" || role === "WebArea") && name) {
      title = name;
    }

    let outLine = `${"  ".repeat(depth)}${role}`;
    if (name) outLine += ` "${name}"`;

    // Parse raw attrs — look for native aria-ref from Playwright
    const attrParts: string[] = rawAttrs
      ? rawAttrs
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      : [];

    // Extract native aria-ref if present (e.g. "aria-ref=e12")
    let nativeAriaRef: string | undefined;
    const outAttrs: string[] = [];
    for (const part of attrParts) {
      const ariaRefMatch = /^aria-ref=(.+)$/.exec(part);
      if (ariaRefMatch) {
        nativeAriaRef = ariaRefMatch[1];
        // Don't pass the native aria-ref through to output — we'll re-emit as ref=eN
      } else {
        outAttrs.push(part);
      }
    }

    if (isInteractive) {
      const occKey = `${role}\0${name}`;
      const nthIndex = occurrenceCount.get(occKey) ?? 0;
      occurrenceCount.set(occKey, nthIndex + 1);

      const refKey = `e${++refCounter}`;
      refs[refKey] = {
        role,
        ...(name ? { name } : {}),
        ...(nativeAriaRef !== undefined ? { ariaRef: nativeAriaRef } : {}),
        nthIndex,
      };
      outAttrs.push(`ref=${refKey}`);
    }

    if (outAttrs.length > 0) outLine += ` [${outAttrs.join(", ")}]`;

    const lineLen = outLine.length + 1;
    if (charCount + lineLen > maxChars) {
      truncated = true;
      break;
    }
    charCount += lineLen;
    lines.push(outLine);
  }

  return {
    text: lines.join("\n"),
    refs,
    truncated,
    ...(title !== undefined ? { title } : {}),
  };
}
