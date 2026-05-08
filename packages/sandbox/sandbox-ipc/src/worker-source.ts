export const WORKER_SOURCE: string = `// @bun
function send(message) {
  if (typeof process.send !== "function") {
    throw new Error("Worker must be spawned with IPC enabled");
  }

  process.send(message);
}

function validateExecuteMessage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Execute message must be an object";
  }

  const record = value;
  if (record.kind !== "execute") {
    return 'Execute message kind must be "execute"';
  }
  if (typeof record.code !== "string") {
    return "Execute message code must be a string";
  }
  if (
    typeof record.timeoutMs !== "number" ||
    !Number.isFinite(record.timeoutMs) ||
    record.timeoutMs <= 0
  ) {
    return "Execute message timeoutMs must be a positive number";
  }
  if (typeof record.input !== "object" || record.input === null || Array.isArray(record.input)) {
    return "Execute message input must be an object";
  }

  return record;
}

function classifyThrownError(message) {
  return message.includes("Permission denied") || message.includes("EACCES")
    ? "PERMISSION"
    : "CRASH";
}

send({ kind: "ready" });

let handled = false;

process.on("message", async (raw) => {
  if (handled) {
    send({
      kind: "error",
      code: "CRASH",
      message: "Worker received duplicate execute message",
      durationMs: 0,
    });
    process.exit(1);
    return;
  }

  const message = validateExecuteMessage(raw);
  if (typeof message === "string") {
    send({
      kind: "error",
      code: "CRASH",
      message,
      durationMs: 0,
    });
    process.exit(1);
    return;
  }

  handled = true;

  const startedAt = performance.now();
  let settled = false;
  const timeoutHandle = setTimeout(() => {
    if (settled) {
      return;
    }

    settled = true;
    send({
      kind: "error",
      code: "TIMEOUT",
      message: "Worker execution timed out",
      durationMs: message.timeoutMs,
    });
    process.exit(124);
  }, message.timeoutMs);

  try {
    const fn = new Function("input", message.code);
    const output = await Promise.resolve(fn(message.input));

    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeoutHandle);
    send({
      kind: "result",
      output,
      durationMs: performance.now() - startedAt,
    });
    process.exit(0);
  } catch (error) {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeoutHandle);
    const errorMessage = error instanceof Error ? error.message : String(error);
    send({
      kind: "error",
      code: classifyThrownError(errorMessage),
      message: errorMessage,
      durationMs: performance.now() - startedAt,
    });
    process.exit(1);
  }
});
`;
