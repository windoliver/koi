/**
 * Minimal ambient declaration for URLPattern.
 *
 * URLPattern is a WHATWG web standard available globally in Bun (1.2+) and
 * modern browsers, but it is not in TS's ES2025 lib (DOM-only) and is not
 * shipped by `bun-types` or `undici-types`. This file declares the subset
 * used in tests so they typecheck without pulling in the full DOM lib.
 *
 * Mirrors `packages/security/governance-scope/src/url-pattern.d.ts`. Both
 * packages need their own copy because tsconfig `rootDir: "src"` plus
 * `composite: true` rejects ambient files outside rootDir.
 */

interface URLPatternInit {
  readonly protocol?: string;
  readonly username?: string;
  readonly password?: string;
  readonly hostname?: string;
  readonly port?: string;
  readonly pathname?: string;
  readonly search?: string;
  readonly hash?: string;
  readonly baseURL?: string;
}

declare global {
  // biome-ignore lint/correctness/noUnusedVariables: ambient global declaration
  class URLPattern {
    constructor(input?: URLPatternInit | string, baseURL?: string);
    test(input: string | URLPatternInit, baseURL?: string): boolean;
  }
}

export {};
