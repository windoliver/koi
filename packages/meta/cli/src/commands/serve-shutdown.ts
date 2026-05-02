export function defaultWaitForShutdownSignal(): Promise<string> {
  return new Promise((resolve) => {
    let onSigint: () => void;
    let onSigterm: () => void;
    const cleanup = (): void => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    onSigint = (): void => {
      cleanup();
      resolve("SIGINT");
    };
    onSigterm = (): void => {
      cleanup();
      resolve("SIGTERM");
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}
