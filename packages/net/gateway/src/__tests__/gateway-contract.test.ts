/**
 * Contract test: createGateway() must satisfy the Gateway interface from
 * @koi/gateway-types so peer L2 packages (e.g., @koi/gateway-http) can depend
 * on the L0u contract type rather than this package directly.
 */

import { describe, expect, test } from "bun:test";
import type { Gateway as GatewayContract } from "@koi/gateway-types";
import { createGateway } from "../gateway.js";
import { createInMemorySessionStore } from "../session-store.js";
import { createMockTransport, createTestAuthenticator } from "./test-utils.js";

describe("@koi/gateway implements Gateway contract", () => {
  test("createGateway returns a value structurally compatible with Gateway", async () => {
    const gw = createGateway(
      {},
      {
        transport: createMockTransport(),
        auth: createTestAuthenticator(),
        store: createInMemorySessionStore(),
      },
    );
    const asContract: GatewayContract = gw;
    expect(typeof asContract.ingest).toBe("function");
    expect(typeof asContract.pauseIngress).toBe("function");
    expect(typeof asContract.forceClose).toBe("function");
    expect(typeof asContract.activeConnections).toBe("function");
    expect(await asContract.activeConnections()).toBe(0);
  });
});
