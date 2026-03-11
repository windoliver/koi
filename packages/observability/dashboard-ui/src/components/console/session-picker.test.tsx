/**
 * SessionPicker tests — session list display, selection, and new session.
 */

import { describe, expect, mock, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import type { SessionEntry } from "../../hooks/use-session-history.js";
import { render, screen } from "../../__tests__/setup.js";
import { SessionPicker } from "./session-picker.js";

function makeEntry(id: string, modifiedAt = 0): SessionEntry {
  return {
    sessionId: id,
    path: `/agents/a1/session/chat/${id}.jsonl`,
    modifiedAt,
    size: 100,
  };
}

describe("SessionPicker", () => {
  test("shows 'No previous sessions' when empty", () => {
    render(
      <SessionPicker
        sessions={[]}
        isLoading={false}
        currentSessionId={null}
        onSelect={mock(() => {})}
        onNewSession={mock(() => {})}
      />,
    );
    expect(screen.getByText("No previous sessions")).toBeDefined();
  });

  test("shows loading state", () => {
    render(
      <SessionPicker
        sessions={[]}
        isLoading={true}
        currentSessionId={null}
        onSelect={mock(() => {})}
        onNewSession={mock(() => {})}
      />,
    );
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  test("renders session entries", () => {
    const sessions = [makeEntry("sess-1"), makeEntry("sess-2")];
    render(
      <SessionPicker
        sessions={sessions}
        isLoading={false}
        currentSessionId={null}
        onSelect={mock(() => {})}
        onNewSession={mock(() => {})}
      />,
    );
    expect(screen.getByText("sess-1")).toBeDefined();
    expect(screen.getByText("sess-2")).toBeDefined();
  });

  test("calls onSelect when clicking a session", () => {
    const onSelect = mock(() => {});
    const sessions = [makeEntry("sess-1")];
    render(
      <SessionPicker
        sessions={sessions}
        isLoading={false}
        currentSessionId={null}
        onSelect={onSelect}
        onNewSession={mock(() => {})}
      />,
    );
    fireEvent.click(screen.getByText("sess-1"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("does not call onSelect for already-active session", () => {
    const onSelect = mock(() => {});
    const sessions = [makeEntry("sess-1")];
    render(
      <SessionPicker
        sessions={sessions}
        isLoading={false}
        currentSessionId="sess-1"
        onSelect={onSelect}
        onNewSession={mock(() => {})}
      />,
    );
    fireEvent.click(screen.getByText("sess-1"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("calls onNewSession when clicking New", () => {
    const onNewSession = mock(() => {});
    render(
      <SessionPicker
        sessions={[]}
        isLoading={false}
        currentSessionId={null}
        onSelect={mock(() => {})}
        onNewSession={onNewSession}
      />,
    );
    fireEvent.click(screen.getByText("New"));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  test("renders Sessions header", () => {
    render(
      <SessionPicker
        sessions={[]}
        isLoading={false}
        currentSessionId={null}
        onSelect={mock(() => {})}
        onNewSession={mock(() => {})}
      />,
    );
    expect(screen.getByText("Sessions")).toBeDefined();
  });

  test("shows 'Unknown' for zero timestamp", () => {
    const sessions = [makeEntry("sess-1", 0)];
    render(
      <SessionPicker
        sessions={sessions}
        isLoading={false}
        currentSessionId={null}
        onSelect={mock(() => {})}
        onNewSession={mock(() => {})}
      />,
    );
    expect(screen.getByText("Unknown")).toBeDefined();
  });
});
