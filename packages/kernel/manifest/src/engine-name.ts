/**
 * Extracts the engine name from a loaded manifest's engine field.
 *
 * The manifest engine field can be:
 * - `undefined` → defaults to `"pi"`
 * - a `string` → the engine name directly
 * - an `object` with `{ name: string }` → `name` property
 */
import type { LoadedManifest } from "./types.js";

const DEFAULT_ENGINE_NAME = "pi";

export function getEngineName(manifest: LoadedManifest): string {
  const { engine } = manifest;

  if (engine === undefined || engine === null) {
    return DEFAULT_ENGINE_NAME;
  }

  if (typeof engine === "string") {
    return engine;
  }

  if (typeof engine === "object" && "name" in engine && typeof engine.name === "string") {
    return engine.name;
  }

  return DEFAULT_ENGINE_NAME;
}
