/**
 * Console capture bridge for the sandbox.
 *
 * Creates sync host functions (__consoleLog, __consoleError, __consoleWarn) and
 * a JS preamble that overrides the guest's `console` object to route output
 * through these host functions. Captured entries are returned after execution.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
  readonly level: "log" | "error" | "warn";
  readonly message: string;
}

export interface ConsoleBridge {
  /** JS preamble code to inject before user code. */
  readonly preamble: string;
  /** Collected console entries after execution. */
  readonly entries: () => readonly ConsoleEntry[];
  /** Host functions to register (sync — returns immediately). */
  readonly hostFunctions: ReadonlyMap<string, (argsJson: string) => Promise<string>>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createConsoleBridge(): ConsoleBridge {
  const captured: ConsoleEntry[] = [];

  const hostFunctions = new Map<string, (argsJson: string) => Promise<string>>([
    [
      "__consoleLog",
      async (argsJson: string): Promise<string> => {
        captured.push({ level: "log", message: argsJson });
        return "";
      },
    ],
    [
      "__consoleError",
      async (argsJson: string): Promise<string> => {
        captured.push({ level: "error", message: argsJson });
        return "";
      },
    ],
    [
      "__consoleWarn",
      async (argsJson: string): Promise<string> => {
        captured.push({ level: "warn", message: argsJson });
        return "";
      },
    ],
  ]);

  const preamble = `var console = {
  log: function() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      parts.push(typeof arguments[i] === "string" ? arguments[i] : JSON.stringify(arguments[i]));
    }
    __consoleLog(parts.join(" "));
  },
  error: function() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      parts.push(typeof arguments[i] === "string" ? arguments[i] : JSON.stringify(arguments[i]));
    }
    __consoleError(parts.join(" "));
  },
  warn: function() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      parts.push(typeof arguments[i] === "string" ? arguments[i] : JSON.stringify(arguments[i]));
    }
    __consoleWarn(parts.join(" "));
  }
};`;

  return {
    preamble,
    entries: () => [...captured],
    hostFunctions,
  };
}
