import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockMailboxComponent } from "../test-helpers.js";
import { createListTool } from "./list.js";

describe("createListTool", () => {
  test("has correct descriptor", () => {
    const tool = createListTool(createMockMailboxComponent(), "ipc", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("ipc_list");
    expect(tool.descriptor.description).toBeTruthy();
    expect(tool.policy.sandbox).toBe(false);
  });

  test("returns all messages when no filter provided", async () => {
    const component = createMockMailboxComponent();
    const tool = createListTool(component, "ipc", DEFAULT_UNSANDBOXED_POLICY);

    const result = await tool.execute({});
    const r = result as { messages: readonly unknown[] };
    expect(r.messages).toHaveLength(2);
  });

  test("filters by kind", async () => {
    const component = createMockMailboxComponent();
    const tool = createListTool(component, "ipc", DEFAULT_UNSANDBOXED_POLICY);

    const result = await tool.execute({ kind: "request" });
    const r = result as { messages: readonly { kind: string }[] };
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.kind).toBe("request");
  });

  test("filters by type", async () => {
    const component = createMockMailboxComponent();
    const tool = createListTool(component, "ipc", DEFAULT_UNSANDBOXED_POLICY);

    const result = await tool.execute({ type: "deploy" });
    const r = result as { messages: readonly { type: string }[] };
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.type).toBe("deploy");
  });

  test("respects custom prefix", () => {
    const tool = createListTool(createMockMailboxComponent(), "msg", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("msg_list");
    expect(tool.policy.sandbox).toBe(false);
  });

  test("returns error envelope on exception", async () => {
    const failingComponent = {
      send: createMockMailboxComponent().send,
      onMessage: createMockMailboxComponent().onMessage,
      list: () => {
        throw new Error("list failed");
      },
    };
    const tool = createListTool(failingComponent, "ipc", DEFAULT_UNSANDBOXED_POLICY);

    const result = await tool.execute({});
    const r = result as { error: string; code: string };
    expect(r.code).toBe("INTERNAL");
    expect(r.error).toContain("list failed");
  });
});
