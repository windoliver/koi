/**
 * Drift test: assert the runtime (value) surface of @koi/channel-email is
 * stable. Type-only re-exports are erased at runtime so they are caught by
 * `bun run typecheck`, not here. This guards against accidentally
 * exporting new factories or helpers without an explicit decision.
 */

import { describe, expect, test } from "bun:test";
import * as channelEmail from "../index.js";

describe("@koi/channel-email public API surface", () => {
  test("exported names are stable", () => {
    const names = Object.keys(channelEmail).sort();
    expect(names).toEqual(["createEmailChannel", "validateEmailConfig"].sort());
  });
});
