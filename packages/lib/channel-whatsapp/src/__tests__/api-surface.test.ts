/**
 * Drift test: assert the runtime (value) surface of @koi/channel-whatsapp is
 * stable. Type-only re-exports are erased at runtime so they are caught by
 * `bun run typecheck`, not here.
 */

import { describe, expect, test } from "bun:test";
import * as channelWhatsApp from "../index.js";

describe("@koi/channel-whatsapp public API surface", () => {
  test("exported names are stable", () => {
    const names = Object.keys(channelWhatsApp).sort();
    expect(names).toEqual(
      ["createWhatsAppChannel", "validateWhatsAppConfig", "verifyMetaSignature"].sort(),
    );
  });
});
