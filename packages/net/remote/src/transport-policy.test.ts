import { describe, expect, test } from "bun:test";

import { enforceRemoteTransportPolicy } from "./index.js";

describe("enforceRemoteTransportPolicy", () => {
  test("websocket allows read and stream operations", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "websocket",
        operation: "read",
        url: "wss://remote.example.com/session",
      }),
    ).toEqual({ ok: true });
    expect(
      enforceRemoteTransportPolicy({
        transport: "websocket",
        operation: "stream",
        url: "wss://remote.example.com/session",
      }),
    ).toEqual({ ok: true });
  });

  test("websocket rejects write operations", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "websocket",
        operation: "write",
        url: "wss://remote.example.com/session",
      }),
    ).toEqual({ ok: false, reason: "wrong_transport" });
  });

  test("wrong transport rejects before insecure transport", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "websocket",
        operation: "write",
        url: "http://example.com/session",
      }),
    ).toEqual({ ok: false, reason: "wrong_transport" });
  });

  test("http post allows write operations", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "write",
        url: "https://remote.example.com/session",
      }),
    ).toEqual({ ok: true });
  });

  test("http post rejects read and stream operations", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "read",
        url: "https://remote.example.com/session",
      }),
    ).toEqual({ ok: false, reason: "wrong_transport" });
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "stream",
        url: "https://remote.example.com/session",
      }),
    ).toEqual({ ok: false, reason: "wrong_transport" });
  });

  test("invalid runtime transport and operation values reject", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "bogus" as "websocket",
        operation: "write",
        url: "https://remote.example.com/session",
      }),
    ).toEqual({ ok: false, reason: "wrong_transport" });
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "bogus" as "write",
        url: "https://remote.example.com/session",
      }),
    ).toEqual({ ok: false, reason: "wrong_transport" });
  });

  test("transport must match URL scheme family", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "websocket",
        operation: "read",
        url: "https://remote.example.com/session",
      }),
    ).toEqual({ ok: false, reason: "insecure_transport" });
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "write",
        url: "wss://remote.example.com/session",
      }),
    ).toEqual({ ok: false, reason: "insecure_transport" });
  });

  test("cleartext non-loopback transport rejects", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "write",
        url: "http://example.com/session",
        allowInsecureLocalhost: true,
      }),
    ).toEqual({ ok: false, reason: "insecure_transport" });
  });

  test("invalid URL rejects", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "write",
        url: "not a url",
      }),
    ).toEqual({ ok: false, reason: "insecure_transport" });
  });

  test("cleartext loopback transport requires explicit opt-in", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "write",
        url: "http://127.0.0.1:1234/session",
      }),
    ).toEqual({ ok: false, reason: "insecure_transport" });
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "write",
        url: "http://127.0.0.1:1234/session",
        allowInsecureLocalhost: true,
      }),
    ).toEqual({ ok: true });
  });

  test("cleartext localhost and ipv6 loopback are local-only", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "websocket",
        operation: "read",
        url: "ws://localhost/session",
        allowInsecureLocalhost: true,
      }),
    ).toEqual({ ok: true });
    expect(
      enforceRemoteTransportPolicy({
        transport: "websocket",
        operation: "stream",
        url: "ws://[::1]/session",
        allowInsecureLocalhost: true,
      }),
    ).toEqual({ ok: true });
  });

  test("cleartext near-miss loopback host rejects", () => {
    expect(
      enforceRemoteTransportPolicy({
        transport: "http-post",
        operation: "write",
        url: "http://127.0.0.2:1234/session",
        allowInsecureLocalhost: true,
      }),
    ).toEqual({ ok: false, reason: "insecure_transport" });
  });
});
