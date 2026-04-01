import { describe, expect, test } from "bun:test";
import { createInitialMailboxView } from "../state/domain-types.js";
import { MailboxView } from "./mailbox-view.js";

describe("MailboxView", () => {
  test("is a function component", () => {
    expect(typeof MailboxView).toBe("function");
  });

  test("accepts MailboxViewState props", () => {
    const props = {
      mailboxView: createInitialMailboxView(),
      focused: true,
      zoomLevel: "normal" as const,
    };
    expect(props.mailboxView.messages).toEqual([]);
    expect(props.mailboxView.scrollOffset).toBe(0);
    expect(props.mailboxView.loading).toBe(false);
  });

  test("initial state has empty messages", () => {
    const state = createInitialMailboxView();
    expect(state.messages).toHaveLength(0);
  });
});
