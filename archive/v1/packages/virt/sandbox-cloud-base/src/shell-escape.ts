/**
 * Shell-escape a single argument for safe interpolation into a shell command string.
 *
 * Wraps the argument in single quotes and escapes any embedded single quotes.
 * This prevents shell metacharacter interpretation when cloud SDK `commands.run()`
 * accepts a single command string instead of an argv array.
 */
export function shellEscape(arg: string): string {
  if (arg === "") return "''";
  // If the arg only contains safe characters, no quoting needed.
  if (/^[a-zA-Z0-9._\-/=:@]+$/.test(arg)) return arg;
  // Wrap in single quotes, escaping any embedded single quotes:
  // foo'bar → 'foo'\''bar'
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Join a command and its arguments into a single shell-safe string.
 * Each argument is individually escaped before joining.
 */
export function shellJoin(command: string, args: readonly string[]): string {
  if (args.length === 0) return command;
  return `${shellEscape(command)} ${args.map(shellEscape).join(" ")}`;
}
