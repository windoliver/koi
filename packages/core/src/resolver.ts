/**
 * Resolver contract — discovery of tools/skills/agents.
 */

import type { KoiError, Result } from "./errors.js";

export interface Resolver<TMeta, TFull> {
  readonly discover: () => Promise<readonly TMeta[]>;
  readonly load: (id: string) => Promise<Result<TFull, KoiError>>;
  readonly onChange?: (listener: () => void) => () => void;
}
