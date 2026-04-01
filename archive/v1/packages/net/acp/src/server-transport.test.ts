/**
 * Tests for the server-side process transport.
 *
 * Since createProcessTransport() depends on process.stdin/stdout,
 * we test the interface contract rather than the full I/O path.
 * Full integration testing happens in __tests__/protocol-flow.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { createProcessTransport } from "./server-transport.js";

describe("createProcessTransport", () => {
  test("returns an object implementing AcpTransport interface", () => {
    // We can't fully test stdin/stdout in unit tests, but we can verify
    // the returned object has the correct shape.
    const transport = createProcessTransport();
    expect(typeof transport.send).toBe("function");
    expect(typeof transport.receive).toBe("function");
    expect(typeof transport.close).toBe("function");
  });

  test("send is no-op after close", () => {
    const transport = createProcessTransport();
    transport.close();
    // Should not throw
    transport.send('{"jsonrpc":"2.0","method":"test"}');
  });
});
