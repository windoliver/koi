import { describe, test } from "bun:test";
import { agentId } from "@koi/core";
import type { LocalMailboxConfig, MailboxRouter } from "../index.js";
import { createLocalMailbox, createLocalMailboxRouter } from "../index.js";

describe("@koi/ipc-local — API surface", () => {
  test("createLocalMailbox is a function", () => {
    const _: (config: LocalMailboxConfig) => ReturnType<typeof createLocalMailbox> =
      createLocalMailbox;
    void _;
  });

  test("createLocalMailboxRouter is a function", () => {
    const _: () => MailboxRouter = createLocalMailboxRouter;
    void _;
  });

  test("createLocalMailbox returns MailboxComponent shape", () => {
    const mailbox = createLocalMailbox({ agentId: agentId("owner") });
    const _send: typeof mailbox.send = mailbox.send;
    const _onMessage: typeof mailbox.onMessage = mailbox.onMessage;
    const _list: typeof mailbox.list = mailbox.list;
    const _close: typeof mailbox.close = mailbox.close;
    void _send;
    void _onMessage;
    void _list;
    void _close;
    mailbox.close();
  });

  test("createLocalMailboxRouter returns MailboxRouter shape", () => {
    const router = createLocalMailboxRouter();
    const _register: typeof router.register = router.register;
    const _unregister: typeof router.unregister = router.unregister;
    const _getView: typeof router.getView = router.getView;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const _get: typeof router.get = router.get;
    void _register;
    void _unregister;
    void _getView;
    void _get;
  });
});
