import { afterEach, describe, expect, mock, test } from "bun:test";
import type { InitFlags } from "../args.js";
import { DEFAULT_STATE, MODELS, type WizardState } from "./state.js";

// Mock @clack/prompts before importing steps
const mockSelect = mock(() => Promise.resolve("minimal"));
const mockText = mock(() => Promise.resolve("test-agent"));
const mockMultiselect = mock(() => Promise.resolve(["cli"]));
const mockConfirm = mock(() => Promise.resolve(true));
const mockIntro = mock(() => {});
const mockOutro = mock(() => {});
const mockCancel = mock(() => {});
const mockIsCancel = mock((value: unknown) => value === Symbol.for("cancel"));

mock.module("@clack/prompts", () => ({
  select: mockSelect,
  text: mockText,
  multiselect: mockMultiselect,
  confirm: mockConfirm,
  intro: mockIntro,
  outro: mockOutro,
  cancel: mockCancel,
  isCancel: mockIsCancel,
}));

// Import steps AFTER mocking
const {
  selectTemplate,
  enterName,
  enterDescription,
  selectModel,
  selectEngine,
  selectChannels,
  isValidModel,
  isValidName,
} = await import("./steps.js");

const NO_FLAGS: InitFlags = {
  command: "init",
  directory: undefined,
  yes: false,
  name: undefined,
  template: undefined,
  model: undefined,
  engine: undefined,
};

const YES_FLAGS: InitFlags = {
  ...NO_FLAGS,
  yes: true,
};

afterEach(() => {
  mockSelect.mockClear();
  mockText.mockClear();
  mockMultiselect.mockClear();
  mockConfirm.mockClear();
  mockCancel.mockClear();
});

describe("selectTemplate", () => {
  test("prompts user when no flag provided", async () => {
    mockSelect.mockResolvedValueOnce("copilot");
    const result = await selectTemplate(DEFAULT_STATE, NO_FLAGS);
    expect(result?.template).toBe("copilot");
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  test("uses flag value when --template provided", async () => {
    const flags: InitFlags = { ...NO_FLAGS, template: "copilot" };
    const result = await selectTemplate(DEFAULT_STATE, flags);
    expect(result?.template).toBe("copilot");
    expect(mockSelect).not.toHaveBeenCalled();
  });

  test("rejects unknown --template flag value", async () => {
    const flags: InitFlags = { ...NO_FLAGS, template: "unknown-template" };
    const result = await selectTemplate(DEFAULT_STATE, flags);
    expect(result).toBeNull();
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  test("uses default in --yes mode", async () => {
    const result = await selectTemplate(DEFAULT_STATE, YES_FLAGS);
    expect(result?.template).toBe("minimal");
    expect(mockSelect).not.toHaveBeenCalled();
  });

  test("returns cancelled when user cancels", async () => {
    mockSelect.mockResolvedValueOnce(Symbol.for("cancel") as unknown as string);
    mockIsCancel.mockReturnValueOnce(true);
    const result = await selectTemplate(DEFAULT_STATE, NO_FLAGS);
    expect(result).toBeNull();
  });
});

describe("enterName", () => {
  test("prompts user when no flag provided", async () => {
    mockText.mockResolvedValueOnce("my-agent");
    const result = await enterName(DEFAULT_STATE, NO_FLAGS);
    expect(result?.name).toBe("my-agent");
    expect(mockText).toHaveBeenCalledTimes(1);
  });

  test("uses flag value when --name provided", async () => {
    const flags: InitFlags = { ...NO_FLAGS, name: "flag-agent" };
    const result = await enterName(DEFAULT_STATE, flags);
    expect(result?.name).toBe("flag-agent");
    expect(mockText).not.toHaveBeenCalled();
  });

  test("rejects invalid --name flag with uppercase", async () => {
    const flags: InitFlags = { ...NO_FLAGS, name: "MyAgent" };
    const result = await enterName(DEFAULT_STATE, flags);
    expect(result).toBeNull();
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid --name flag with spaces", async () => {
    const flags: InitFlags = { ...NO_FLAGS, name: "my agent" };
    const result = await enterName(DEFAULT_STATE, flags);
    expect(result).toBeNull();
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  test("accepts valid --name with dots and underscores", async () => {
    const flags: InitFlags = { ...NO_FLAGS, name: "my_agent.v2" };
    const result = await enterName(DEFAULT_STATE, flags);
    expect(result?.name).toBe("my_agent.v2");
  });

  test("uses directory name as default in --yes mode", async () => {
    const state: WizardState = { ...DEFAULT_STATE, directory: "my-project" };
    const result = await enterName(state, YES_FLAGS);
    expect(result?.name).toBe("my-project");
    expect(mockText).not.toHaveBeenCalled();
  });

  test("uses 'koi-agent' as fallback when directory is '.'", async () => {
    const result = await enterName(DEFAULT_STATE, YES_FLAGS);
    expect(result?.name).toBe("koi-agent");
    expect(mockText).not.toHaveBeenCalled();
  });

  test("returns cancelled when user cancels", async () => {
    mockText.mockResolvedValueOnce(Symbol.for("cancel") as unknown as string);
    mockIsCancel.mockReturnValueOnce(true);
    const result = await enterName(DEFAULT_STATE, NO_FLAGS);
    expect(result).toBeNull();
  });
});

describe("enterDescription", () => {
  test("prompts user when interactive", async () => {
    mockText.mockResolvedValueOnce("A research agent");
    const result = await enterDescription(DEFAULT_STATE, NO_FLAGS);
    expect(result?.description).toBe("A research agent");
  });

  test("uses default in --yes mode", async () => {
    const result = await enterDescription(DEFAULT_STATE, YES_FLAGS);
    expect(result?.description).toBe("A Koi agent");
    expect(mockText).not.toHaveBeenCalled();
  });
});

describe("selectModel", () => {
  test("prompts user when no flag provided", async () => {
    mockSelect.mockResolvedValueOnce("openai:gpt-4o");
    const result = await selectModel(DEFAULT_STATE, NO_FLAGS);
    expect(result?.model).toBe("openai:gpt-4o");
  });

  test("uses flag value when --model provided", async () => {
    const flags: InitFlags = { ...NO_FLAGS, model: "openai:gpt-4o" };
    const result = await selectModel(DEFAULT_STATE, flags);
    expect(result?.model).toBe("openai:gpt-4o");
    expect(mockSelect).not.toHaveBeenCalled();
  });

  test("accepts supported provider:model values outside the curated preset list", async () => {
    const flags: InitFlags = { ...NO_FLAGS, model: "openrouter:google/gemini-2.0-flash-001" };
    const result = await selectModel(DEFAULT_STATE, flags);
    expect(result?.model).toBe("openrouter:google/gemini-2.0-flash-001");
    expect(mockSelect).not.toHaveBeenCalled();
  });

  test("rejects unsupported --model provider", async () => {
    const flags: InitFlags = { ...NO_FLAGS, model: "fake:model-9000" };
    const result = await selectModel(DEFAULT_STATE, flags);
    expect(result).toBeNull();
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  test("uses default in --yes mode", async () => {
    const result = await selectModel(DEFAULT_STATE, YES_FLAGS);
    expect(result?.model).toBe(MODELS[0]);
  });
});

describe("isValidModel", () => {
  test("accepts curated OpenRouter preset", () => {
    expect(isValidModel("openrouter:anthropic/claude-sonnet-4.6")).toBe(true);
  });

  test("accepts arbitrary model names for supported providers", () => {
    expect(isValidModel("openrouter:google/gemini-2.0-flash-001")).toBe(true);
  });

  test("rejects unsupported providers", () => {
    expect(isValidModel("fake:model")).toBe(false);
  });

  test("rejects malformed model names", () => {
    expect(isValidModel("openrouter")).toBe(false);
    expect(isValidModel("openrouter:")).toBe(false);
    expect(isValidModel(":anthropic/claude-sonnet-4.6")).toBe(false);
  });
});

describe("selectEngine", () => {
  test("skips prompting when no engine override is provided", async () => {
    const result = await selectEngine(DEFAULT_STATE, NO_FLAGS);
    expect(result?.engine).toBeUndefined();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  test("uses flag value when --engine provided", async () => {
    const flags: InitFlags = { ...NO_FLAGS, engine: "@koi/engine-external" };
    const result = await selectEngine(DEFAULT_STATE, flags);
    expect(result?.engine).toBe("@koi/engine-external");
    expect(mockSelect).not.toHaveBeenCalled();
  });

  test("rejects empty --engine flag value", async () => {
    const flags: InitFlags = { ...NO_FLAGS, engine: "   " };
    const result = await selectEngine(DEFAULT_STATE, flags);
    expect(result).toBeNull();
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  test("keeps default in --yes mode", async () => {
    const result = await selectEngine(DEFAULT_STATE, YES_FLAGS);
    expect(result?.engine).toBeUndefined();
  });
});

describe("isValidName", () => {
  test("accepts lowercase alphanumeric", () => {
    expect(isValidName("my-agent")).toBe(true);
  });

  test("accepts dots and underscores", () => {
    expect(isValidName("my_agent.v2")).toBe(true);
  });

  test("rejects uppercase", () => {
    expect(isValidName("MyAgent")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(isValidName("my agent")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidName("")).toBe(false);
  });

  test("rejects leading hyphen", () => {
    expect(isValidName("-my-agent")).toBe(false);
  });

  test("rejects special characters", () => {
    expect(isValidName("agent@home")).toBe(false);
  });
});

describe("selectChannels", () => {
  test("prompts for copilot template", async () => {
    mockMultiselect.mockResolvedValueOnce(["telegram", "slack"]);
    const state: WizardState = { ...DEFAULT_STATE, template: "copilot" };
    const result = await selectChannels(state, NO_FLAGS);
    expect(result?.channels).toEqual(["telegram", "slack"]);
    expect(mockMultiselect).toHaveBeenCalledWith({
      message: "Select channels",
      options: [
        { value: "cli", label: "cli" },
        { value: "telegram", label: "telegram" },
        { value: "slack", label: "slack" },
        { value: "discord", label: "discord" },
      ],
      initialValues: ["cli"],
      required: true,
    });
  });

  test("skips prompt for minimal template", async () => {
    const result = await selectChannels(DEFAULT_STATE, NO_FLAGS);
    expect(result?.channels).toEqual(["cli"]);
    expect(mockMultiselect).not.toHaveBeenCalled();
  });

  test("uses default channels in --yes mode for copilot", async () => {
    const state: WizardState = { ...DEFAULT_STATE, template: "copilot" };
    const result = await selectChannels(state, YES_FLAGS);
    expect(result?.channels).toEqual(["cli"]);
    expect(mockMultiselect).not.toHaveBeenCalled();
  });
});
