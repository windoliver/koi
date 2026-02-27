/**
 * @koi/edit-match — Search-and-replace with cascading match strategies.
 *
 * Provides findMatch and applyEdit for forge_edit tool support.
 * Strategies cascade from exact → whitespace-normalized → indentation-flexible → fuzzy.
 */

export { applyEdit, findMatch } from "./cascade.js";
export { FUZZY_THRESHOLD } from "./levenshtein.js";
export {
  matchExact,
  matchFuzzy,
  matchIndentationFlexible,
  matchWhitespaceNormalized,
} from "./strategies.js";
export type { EditResult, MatchResult, MatchStrategy } from "./types.js";
