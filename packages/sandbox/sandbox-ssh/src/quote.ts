/**
 * Quote a single argument for safe inclusion in a POSIX shell command line.
 *
 * Wraps the argument in single quotes; any literal single quotes inside the
 * argument are escaped by closing the quote, inserting an escaped quote, and
 * reopening. Empty strings become `''` (a literal empty argument, not nothing).
 *
 * Example:
 *   quoteArg("hello world")   === "'hello world'"
 *   quoteArg("it's")          === "'it'\\''s'"
 *   quoteArg("")              === "''"
 */
export function quoteArg(arg: string): string {
  if (arg.length === 0) return "''";
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Compose a shell command line from a command and its argument list with
 * each argument independently quoted. Uses POSIX shell quoting rules.
 *
 * The returned string is suitable for `Client.exec(line)` from the `ssh2`
 * package (which interprets the argument as a shell command). NEVER pass
 * raw user input concatenated into a command — always go through this.
 */
export function composeCommandLine(command: string, args: readonly string[]): string {
  const parts: string[] = [quoteArg(command)];
  for (const a of args) parts.push(quoteArg(a));
  return parts.join(" ");
}
