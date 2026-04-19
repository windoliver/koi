/**
 * ToastOverlay tests — top-right transient notifications (gov-9).
 *
 * Uses the same testRender harness as HelpView/DoctorView/MessageList.
 */

import { testRender } from "@opentui/solid";
import { describe, expect, mock, test } from "bun:test";
import type { Toast } from "../state/types.js";
import { ToastOverlay } from "./Toast.js";

const OPTS = { width: 80, height: 24 } as const;

describe("ToastOverlay", () => {
  test("renders nothing when toasts array is empty", async () => {
    const utils = await testRender(
      () => <ToastOverlay toasts={[]} onDismiss={() => {}} />,
      OPTS,
    );
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    // No glyph/title visible
    expect(frame).not.toContain("⚠");
    expect(frame).not.toContain("ⓘ");
    expect(frame).not.toContain("✗");
    utils.renderer.destroy();
  });

  test("renders title + body for each toast", async () => {
    const toast: Toast = {
      id: "t1",
      kind: "warn",
      key: "k",
      title: "Budget alert",
      body: "$1.60 / $2.00",
      ts: 0,
    };
    const utils = await testRender(
      () => <ToastOverlay toasts={[toast]} onDismiss={() => {}} />,
      OPTS,
    );
    await utils.renderOnce();
    const frame = utils.captureCharFrame();
    expect(frame).toContain("Budget alert");
    expect(frame).toContain("$1.60 / $2.00");
    utils.renderer.destroy();
  });

  test("warn kind uses warning glyph", async () => {
    const toast: Toast = { id: "t1", kind: "warn", key: "k", title: "x", body: "y", ts: 0 };
    const utils = await testRender(
      () => <ToastOverlay toasts={[toast]} onDismiss={() => {}} />,
      OPTS,
    );
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("⚠");
    utils.renderer.destroy();
  });

  test("error kind uses error glyph", async () => {
    const toast: Toast = { id: "t1", kind: "error", key: "k", title: "boom", body: "", ts: 0 };
    const utils = await testRender(
      () => <ToastOverlay toasts={[toast]} onDismiss={() => {}} />,
      OPTS,
    );
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("✗");
    utils.renderer.destroy();
  });

  test("info kind uses info glyph", async () => {
    const toast: Toast = { id: "t1", kind: "info", key: "k", title: "fyi", body: "", ts: 0 };
    const utils = await testRender(
      () => <ToastOverlay toasts={[toast]} onDismiss={() => {}} />,
      OPTS,
    );
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("ⓘ");
    utils.renderer.destroy();
  });

  test("auto-dismiss timer calls onDismiss with the toast id", async () => {
    const onDismiss = mock((_id: string) => {});
    const toast: Toast = {
      id: "t-fast",
      kind: "info",
      key: "k",
      title: "x",
      body: "y",
      ts: 0,
      autoDismissMs: 50,
    };
    const utils = await testRender(
      () => <ToastOverlay toasts={[toast]} onDismiss={onDismiss} />,
      OPTS,
    );
    await utils.renderOnce();
    await new Promise((r) => setTimeout(r, 80));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith("t-fast");
    utils.renderer.destroy();
  });
});
