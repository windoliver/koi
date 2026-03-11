import { describe, expect, test } from "bun:test";
import { createCommandPalette, DEFAULT_COMMANDS } from "./command-palette.js";

describe("createCommandPalette", () => {
  test("creates component with default commands", () => {
    const palette = createCommandPalette({
      onSelect: () => {},
      onCancel: () => {},
    });
    expect(palette.component).toBeDefined();
    expect(typeof palette.reset).toBe("function");
  });

  test("includes all expected commands", () => {
    const ids = DEFAULT_COMMANDS.map((c) => c.id);
    expect(ids).toContain("agents");
    expect(ids).toContain("attach");
    expect(ids).toContain("dispatch");
    expect(ids).toContain("refresh");
    expect(ids).toContain("suspend");
    expect(ids).toContain("resume");
    expect(ids).toContain("terminate");
    expect(ids).toContain("cancel");
    expect(ids).toContain("sessions");
    expect(ids).toContain("logs");
    expect(ids).toContain("health");
    expect(ids).toContain("open-browser");
    expect(ids).toContain("quit");
  });

  test("renders with default commands", () => {
    const palette = createCommandPalette({
      onSelect: () => {},
      onCancel: () => {},
    });
    const lines = palette.component.render(60);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("calls onSelect with command id", () => {
    let selectedCmd: string | undefined;
    const palette = createCommandPalette({
      onSelect: (id) => {
        selectedCmd = id;
      },
      onCancel: () => {},
    });

    const item = palette.component.getSelectedItem();
    if (item !== null) {
      palette.component.onSelect?.(item);
    }
    expect(selectedCmd).toBe(DEFAULT_COMMANDS[0]?.id);
  });

  test("calls onCancel", () => {
    let cancelled = false;
    const palette = createCommandPalette({
      onSelect: () => {},
      onCancel: () => {
        cancelled = true;
      },
    });
    palette.component.onCancel?.();
    expect(cancelled).toBe(true);
  });

  test("reset clears filter", () => {
    const palette = createCommandPalette({
      onSelect: () => {},
      onCancel: () => {},
    });
    palette.component.setFilter("xyz");
    palette.reset();
    const item = palette.component.getSelectedItem();
    expect(item?.value).toBe(DEFAULT_COMMANDS[0]?.id);
  });

  test("accepts custom commands", () => {
    let selectedCmd: string | undefined;
    const palette = createCommandPalette(
      {
        onSelect: (id) => {
          selectedCmd = id;
        },
        onCancel: () => {},
      },
      [{ id: "custom", label: "/custom", description: "Custom command" }],
    );

    const item = palette.component.getSelectedItem();
    if (item !== null) {
      palette.component.onSelect?.(item);
    }
    expect(selectedCmd).toBe("custom");
  });
});
