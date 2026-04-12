/**
 * Typed registry of cassette name → absolute path.
 *
 * - Single source of truth: adding a cassette file requires a registry entry.
 * - `check:golden-queries` uses this to detect cassettes with no test coverage.
 * - Tests import from here instead of constructing paths by string,
 *   so a rename/move is a compile error, not a silent test failure.
 *
 * Convention: key = cassette `name` field, value = absolute path via import.meta.
 * Packages that ship their own cassettes should export their own local registry
 * using the same shape (`Record<string, string>`).
 */
export type CassetteRegistry = Readonly<Record<string, string>>;

/**
 * Creates a cassette registry from a base directory and a map of name → filename.
 * Paths are resolved relative to the given base directory.
 *
 * Example:
 *   const CASSETTES = createRegistry(import.meta.dirname + "/../fixtures", {
 *     "simple-text": "simple-text.cassette.json",
 *     "tool-use":    "tool-use.cassette.json",
 *   });
 */
export function createRegistry(
  baseDir: string,
  entries: Readonly<Record<string, string>>,
): CassetteRegistry {
  const result: Record<string, string> = {};
  for (const [name, filename] of Object.entries(entries)) {
    result[name] = `${baseDir}/${filename}`;
  }
  return result;
}
