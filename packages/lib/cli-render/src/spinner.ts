/**
 * Minimal terminal spinner — zero dependencies.
 *
 * Writes to stderr so it doesn't pollute piped stdout.
 * Falls back to a static line in non-TTY environments.
 * Never hides the cursor — avoids terminal corruption on crash.
 * Registers process exit handler to clean up partial ANSI output.
 */

const FRAMES = [
  "\u280B",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283C",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280F",
] as const;
const INTERVAL_MS = 80;

export interface Spinner {
  /** Start the spinner with initial text. */
  readonly start: (text: string) => void;
  /** Stop the spinner and write optional final text. */
  readonly stop: (finalText?: string) => void;
  /** Update the spinner text without restarting. */
  readonly update: (text: string) => void;
  /** Whether the spinner is currently active. */
  readonly isActive: () => boolean;
}

export function createSpinner(stream: NodeJS.WritableStream = process.stderr): Spinner {
  const isTTY = "isTTY" in stream && (stream as NodeJS.WriteStream).isTTY === true;
  let timer: ReturnType<typeof setInterval> | undefined;
  // let justified: frameIndex mutates on each render tick
  let frameIndex = 0;
  // let justified: currentText mutates on update()
  let currentText = "";
  // let justified: active tracks whether the spinner is logically running
  let active = false;

  function clear(): void {
    if (isTTY) stream.write("\x1b[2K\r");
  }

  function render(): void {
    if (!isTTY) return;
    const frame = FRAMES[frameIndex % FRAMES.length] ?? FRAMES[0];
    stream.write(`\x1b[2K\r${frame} ${currentText}`);
    frameIndex = (frameIndex + 1) % FRAMES.length;
  }

  // Cleanup handler to prevent orphaned ANSI state on crash/SIGINT
  function onExit(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
      clear();
    }
  }

  function stopInternal(): void {
    process.removeListener("exit", onExit);
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    clear();
    active = false;
  }

  return {
    start(text: string): void {
      // Reentrant safety: stop any existing interval before starting new one
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      currentText = text;
      frameIndex = 0;
      active = true;
      if (!isTTY) {
        // Non-TTY: always write the static line (each start() is a new phase)
        stream.write(`${text}\n`);
        return;
      }
      render();
      timer = setInterval(render, INTERVAL_MS);
      process.on("exit", onExit);
    },
    stop(finalText?: string): void {
      stopInternal();
      if (finalText !== undefined) stream.write(`${finalText}\n`);
    },
    update(text: string): void {
      currentText = text;
    },
    isActive(): boolean {
      return active;
    },
  };
}
