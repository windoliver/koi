/**
 * Content block traversal — sanitize strings within ContentBlock and InboundMessage.
 */

import type {
  ButtonBlock,
  ContentBlock,
  FileBlock,
  ImageBlock,
  InboundMessage,
  TextBlock,
} from "@koi/core/message";
import type {
  ContentBlockKind,
  SanitizationEvent,
  SanitizationLocation,
  SanitizeRule,
} from "./types.js";

/** Result of sanitizing a single string. */
export interface SanitizeStringResult {
  readonly text: string;
  readonly blocked: boolean;
  readonly events: readonly SanitizationEvent[];
}

/** Result of sanitizing a content block. */
export interface SanitizeBlockResult {
  readonly block: ContentBlock;
  readonly blocked: boolean;
  readonly events: readonly SanitizationEvent[];
}

/** Result of sanitizing a full message. */
export interface SanitizeMessageResult {
  readonly message: InboundMessage;
  readonly blocked: boolean;
  readonly events: readonly SanitizationEvent[];
}

/**
 * Apply sanitization rules to a single string.
 * Returns the sanitized text, whether a block rule fired, and all events.
 */
export function sanitizeString(
  text: string,
  rules: readonly SanitizeRule[],
  location: SanitizationLocation,
  blockKind?: ContentBlockKind,
  onSanitization?: (event: SanitizationEvent) => void,
): SanitizeStringResult {
  const events: SanitizationEvent[] = [];

  // let justified: accumulates sanitized text through rule passes
  let current = text;
  // let justified: tracks whether a block action was fired
  let blocked = false;

  for (const rule of rules) {
    // Pre-filter by target block kind
    if (blockKind !== undefined && rule.targets !== undefined && rule.targets.length > 0) {
      if (!rule.targets.includes(blockKind)) {
        continue;
      }
    }

    if (!rule.pattern.test(current)) {
      continue;
    }

    const original = current;

    switch (rule.action.kind) {
      case "strip": {
        current = current.replace(rule.pattern, rule.action.replacement);
        break;
      }
      case "block": {
        blocked = true;
        // Still record the event but don't modify text — caller decides behavior
        break;
      }
      case "flag": {
        current = current.replace(rule.pattern, rule.action.replacement);
        break;
      }
    }

    const event: SanitizationEvent = {
      rule,
      original,
      sanitized: current,
      location,
    };
    events.push(event);
    onSanitization?.(event);
  }

  return { text: current, blocked, events };
}

/**
 * Sanitize string fields within a single ContentBlock.
 * Exhaustive switch on block kind — custom blocks are passed through unchanged.
 */
export function sanitizeBlock(
  block: ContentBlock,
  rules: readonly SanitizeRule[],
  location: SanitizationLocation,
  onSanitization?: (event: SanitizationEvent) => void,
): SanitizeBlockResult {
  switch (block.kind) {
    case "text": {
      const result = sanitizeString(block.text, rules, location, "text", onSanitization);
      if (result.events.length === 0) {
        return { block, blocked: result.blocked, events: result.events };
      }
      const sanitizedBlock: TextBlock = { ...block, text: result.text };
      return { block: sanitizedBlock, blocked: result.blocked, events: result.events };
    }

    case "file": {
      if (block.name === undefined) {
        return { block, blocked: false, events: [] };
      }
      const result = sanitizeString(block.name, rules, location, "file", onSanitization);
      if (result.events.length === 0) {
        return { block, blocked: result.blocked, events: result.events };
      }
      const sanitizedBlock: FileBlock = { ...block, name: result.text };
      return { block: sanitizedBlock, blocked: result.blocked, events: result.events };
    }

    case "image": {
      if (block.alt === undefined) {
        return { block, blocked: false, events: [] };
      }
      const result = sanitizeString(block.alt, rules, location, "image", onSanitization);
      if (result.events.length === 0) {
        return { block, blocked: result.blocked, events: result.events };
      }
      const sanitizedBlock: ImageBlock = { ...block, alt: result.text };
      return { block: sanitizedBlock, blocked: result.blocked, events: result.events };
    }

    case "button": {
      const labelResult = sanitizeString(block.label, rules, location, "button", onSanitization);
      const actionResult = sanitizeString(block.action, rules, location, "button", onSanitization);
      if (labelResult.events.length === 0 && actionResult.events.length === 0) {
        return {
          block,
          blocked: labelResult.blocked || actionResult.blocked,
          events: [],
        };
      }
      const sanitizedBlock: ButtonBlock = {
        ...block,
        label: labelResult.text,
        action: actionResult.text,
      };
      return {
        block: sanitizedBlock,
        blocked: labelResult.blocked || actionResult.blocked,
        events: [...labelResult.events, ...actionResult.events],
      };
    }

    case "custom": {
      // Custom blocks contain unknown data — skip to avoid breaking arbitrary structures
      return { block, blocked: false, events: [] };
    }
  }
}

/**
 * Sanitize all content blocks within an InboundMessage.
 * Returns a new immutable message with sanitized blocks.
 */
export function sanitizeMessage(
  message: InboundMessage,
  rules: readonly SanitizeRule[],
  location: SanitizationLocation,
  onSanitization?: (event: SanitizationEvent) => void,
): SanitizeMessageResult {
  const allEvents: SanitizationEvent[] = [];

  // let justified: tracks aggregated blocked state across blocks
  let anyBlocked = false;
  // let justified: tracks whether any block was modified
  let anyChanged = false;

  const sanitizedContent = message.content.map((block) => {
    const result = sanitizeBlock(block, rules, location, onSanitization);
    if (result.blocked) {
      anyBlocked = true;
    }
    if (result.events.length > 0) {
      anyChanged = true;
      for (const event of result.events) {
        allEvents.push(event);
      }
    }
    return result.block;
  });

  if (!anyChanged) {
    return { message, blocked: anyBlocked, events: allEvents };
  }
  return {
    message: { ...message, content: sanitizedContent },
    blocked: anyBlocked,
    events: allEvents,
  };
}
