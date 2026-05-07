/**
 * Drift test: assert the runtime (value) surface of @koi/channel-teams is
 * stable. Type-only re-exports are erased at runtime so they are caught by
 * `bun run typecheck`, not here.
 */

import { describe, expect, test } from "bun:test";
import * as channelTeams from "../index.js";

describe("@koi/channel-teams public API surface", () => {
  test("exported names are stable", () => {
    const names = Object.keys(channelTeams).sort();
    expect(names).toEqual(
      [
        "createBotFrameworkAppTokenMinter",
        "createTeamsChannel",
        "createTokenVerifier",
        "matchServiceUrl",
        "validateTeamsConfig",
      ].sort(),
    );
  });
});
