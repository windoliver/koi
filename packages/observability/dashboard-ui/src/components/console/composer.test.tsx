/**
 * Composer tests — submit, keyboard, streaming, and empty-input behavior.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { render, screen } from "../../__tests__/setup.js";
import { Composer } from "./composer.js";

function renderComposer(overrides: Partial<{
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
  readonly isStreaming: boolean;
  readonly disabled: boolean;
}> = {}): ReturnType<typeof render> {
  const {
    onSend = mock(() => {}),
    onCancel = mock(() => {}),
    isStreaming = false,
    disabled = false,
  } = overrides;
  return render(
    <Composer onSend={onSend} onCancel={onCancel} isStreaming={isStreaming} disabled={disabled} />,
  );
}

describe("Composer", () => {
  beforeEach(() => {
    // Reset any DOM state
  });

  test("renders textarea with placeholder", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText("Send a message...");
    expect(textarea).toBeDefined();
  });

  test("renders streaming placeholder when streaming", () => {
    renderComposer({ isStreaming: true });
    const textarea = screen.getByPlaceholderText("Waiting for response...");
    expect(textarea).toBeDefined();
  });

  test("calls onSend with trimmed text on Enter", () => {
    const onSend = mock(() => {});
    renderComposer({ onSend });
    const textarea = screen.getByPlaceholderText("Send a message...");

    fireEvent.change(textarea, { target: { value: "  hello world  " } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toBe("hello world");
  });

  test("does not submit on Shift+Enter", () => {
    const onSend = mock(() => {});
    renderComposer({ onSend });
    const textarea = screen.getByPlaceholderText("Send a message...");

    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  test("rejects empty input on Enter", () => {
    const onSend = mock(() => {});
    renderComposer({ onSend });
    const textarea = screen.getByPlaceholderText("Send a message...");

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
  });

  test("rejects empty input on button click", () => {
    const onSend = mock(() => {});
    renderComposer({ onSend });
    const sendButton = screen.getByTitle("Send");

    fireEvent.click(sendButton);

    expect(onSend).not.toHaveBeenCalled();
  });

  test("clears textarea after successful send", () => {
    const onSend = mock(() => {});
    renderComposer({ onSend });
    const textarea = screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(textarea.value).toBe("");
  });

  test("does not send when streaming", () => {
    const onSend = mock(() => {});
    renderComposer({ onSend, isStreaming: true });
    const textarea = screen.getByPlaceholderText("Waiting for response...");

    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
  });

  test("shows cancel button when streaming", () => {
    renderComposer({ isStreaming: true });
    const cancelButton = screen.getByTitle("Cancel");
    expect(cancelButton).toBeDefined();
  });

  test("shows send button when not streaming", () => {
    renderComposer({ isStreaming: false });
    const sendButton = screen.getByTitle("Send");
    expect(sendButton).toBeDefined();
  });

  test("calls onCancel when cancel button clicked", () => {
    const onCancel = mock(() => {});
    renderComposer({ onCancel, isStreaming: true });
    const cancelButton = screen.getByTitle("Cancel");

    fireEvent.click(cancelButton);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("send button is disabled when text is empty", () => {
    renderComposer();
    const sendButton = screen.getByTitle("Send") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
  });

  test("send button is enabled when text is non-empty", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText("Send a message...");
    fireEvent.change(textarea, { target: { value: "hello" } });
    const sendButton = screen.getByTitle("Send") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
  });
});
