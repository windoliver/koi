/**
 * @koi/bash-ast — parser init and cached-promise lifecycle.
 *
 * Web-tree-sitter requires a one-time async initialisation (`Parser.init`)
 * followed by loading the bash grammar from a .wasm file. Both are cached
 * behind a single promise so concurrent first-callers wait on the same init
 * work and the grammar is loaded exactly once.
 *
 * The loaded parser is kept in module-level state so the sync hot path
 * (`classifyBashCommand`) can retrieve it without awaiting. If the hot path
 * runs before `initializeBashAst()` has resolved, it returns
 * `parse-unavailable` with `cause: "not-initialized"` — fail closed.
 *
 * Test-only helpers (`__setParserForTests`, `__resetForTests`) allow
 * injecting a fake parser for fail-closed invariant coverage.
 */

import type { Language as TsLanguage, Parser as TsParser } from "web-tree-sitter";
import { Language, Parser } from "web-tree-sitter";

/**
 * Resolve the path to the vendored grammar relative to this module.
 *
 * Works for both dev (src/init.ts) and built (dist/init.js) layouts because
 * `vendor/` sits one directory above either one under the package root.
 */
const GRAMMAR_URL = new URL("../vendor/tree-sitter-bash.wasm", import.meta.url);

// Module-level state — `let` is required because this IS the cache.
// The test-only reset helpers below restore these to null between test runs.
let initPromise: Promise<void> | null = null;
let cachedParser: TsParser | null = null;

/**
 * Idempotent one-time init. Safe to call concurrently — subsequent callers
 * await the same in-flight promise.
 */
export function initializeBashAst(): Promise<void> {
  if (initPromise === null) {
    initPromise = doInit();
  }
  return initPromise;
}

async function doInit(): Promise<void> {
  await Parser.init();
  const bytes = await Bun.file(GRAMMAR_URL).arrayBuffer();
  const bash: TsLanguage = await Language.load(new Uint8Array(bytes));
  const parser = new Parser();
  parser.setLanguage(bash);
  cachedParser = parser;
}

/**
 * Returns the cached parser, or `null` if init has not yet completed.
 * The sync hot path (`classifyBashCommand`) checks for `null` and returns
 * `parse-unavailable` with `cause: "not-initialized"` — fail closed.
 */
export function getParser(): TsParser | null {
  return cachedParser;
}

/**
 * Test-only: inject a parser directly, bypassing WASM init. Pass `null` to
 * simulate the "parser failed to load" state. Callers that use this helper
 * are asserting fail-closed behavior and MUST `__resetForTests()` afterward.
 */
export function __setParserForTests(parser: TsParser | null): void {
  cachedParser = parser;
  initPromise = parser === null ? null : Promise.resolve();
}

/** Test-only: clear cached state so the next `initializeBashAst()` runs fresh. */
export function __resetForTests(): void {
  cachedParser = null;
  initPromise = null;
}
