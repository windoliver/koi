/**
 * Property-based fuzz of parseRefinementOutput.
 *
 * Two layers of randomized input:
 *   1. Pure noise — strings of arbitrary characters. Parser must
 *      never throw and must return null on garbage.
 *   2. Synthesized markdown — generators that produce structurally
 *      valid 3+ backtick / tilde fences with controlled language tags
 *      and bodies. Round-trip: if we built a single tagged fence,
 *      parser must extract its body.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { parseRefinementOutput } from "./parse-refinement.js";

describe("parser fuzz: never throws on arbitrary input", () => {
  test("string fuzz", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (raw) => {
        const out = parseRefinementOutput(raw);
        expect(out === null || typeof out === "string").toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  test("non-string fuzz", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        if (typeof raw === "string") return true;
        const out = parseRefinementOutput(raw);
        return out === null;
      }),
      { numRuns: 1000 },
    );
  });

  test("output never starts with backticks", () => {
    // If the parser returned a string, that string is meant to be
    // candidate code — it must NOT begin with the fence marker
    // (would mean we leaked the closing fence into the body).
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (raw) => {
        const out = parseRefinementOutput(raw);
        if (out === null) return true;
        return !out.startsWith("```") && !out.startsWith("~~~");
      }),
      { numRuns: 2000 },
    );
  });
});

describe("parser round-trip: tagged fence extracts its body", () => {
  test("3-backtick ts fence with single-line body", () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: 200 })
          // Body must not contain newlines or fence markers — otherwise
          // we'd be testing escape behavior, not round-trip.
          .filter((s) => !s.includes("\n") && !s.includes("```") && s.trim().length > 0),
        (body) => {
          const raw = `\`\`\`ts\n${body}\n\`\`\``;
          expect(parseRefinementOutput(raw)).toBe(body.trim());
        },
      ),
      { numRuns: 500 },
    );
  });

  test("variable-length backtick fences round-trip", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 8 }),
        fc
          .string({ maxLength: 100 })
          .filter((s) => !s.includes("\n") && !s.includes("```") && s.trim().length > 0),
        (fenceLen, body) => {
          const fence = "`".repeat(fenceLen);
          const raw = `${fence}ts\n${body}\n${fence}`;
          expect(parseRefinementOutput(raw)).toBe(body.trim());
        },
      ),
      { numRuns: 300 },
    );
  });

  test("tilde fences round-trip", () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: 100 })
          .filter((s) => !s.includes("\n") && !s.includes("~~~") && s.trim().length > 0),
        (body) => {
          const raw = `~~~ts\n${body}\n~~~`;
          expect(parseRefinementOutput(raw)).toBe(body.trim());
        },
      ),
      { numRuns: 300 },
    );
  });

  test("indented fence round-trips with body", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc
          .string({ maxLength: 100 })
          .filter((s) => !s.includes("\n") && !s.includes("```") && s.trim().length > 0),
        (indent, body) => {
          const sp = " ".repeat(indent);
          const raw = `${sp}\`\`\`ts\n${sp}${body}\n${sp}\`\`\``;
          const out = parseRefinementOutput(raw);
          // Body's leading indent is preserved literally — `.trim()` at
          // the parser collapses it away, but only if it's purely
          // whitespace prefix on every line. For a single-line body
          // it always trims cleanly.
          expect(out).toBe(body.trim());
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("parser fuzz: multi-block disambiguation", () => {
  test("untagged + ts-tagged ⇒ picks ts body", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }).filter((s) => !s.includes("\n") && !s.includes("```")),
        fc.string({ maxLength: 100 }).filter((s) => !s.includes("\n") && !s.includes("```")),
        (otherBody, tsBody) => {
          if (otherBody.trim().length === 0 || tsBody.trim().length === 0) return true;
          const raw = `\`\`\`\n${otherBody}\n\`\`\`\nthen\n\`\`\`ts\n${tsBody}\n\`\`\``;
          return parseRefinementOutput(raw) === tsBody.trim();
        },
      ),
      { numRuns: 300 },
    );
  });

  test("two ts-tagged ⇒ ambiguous, returns null", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }).filter((s) => !s.includes("\n") && !s.includes("```")),
        fc.string({ maxLength: 100 }).filter((s) => !s.includes("\n") && !s.includes("```")),
        (a, b) => {
          if (a.trim().length === 0 || b.trim().length === 0) return true;
          const raw = `\`\`\`ts\n${a}\n\`\`\`\nand\n\`\`\`ts\n${b}\n\`\`\``;
          return parseRefinementOutput(raw) === null;
        },
      ),
      { numRuns: 300 },
    );
  });
});
