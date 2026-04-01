/**
 * Shallow template interpolation for rule action messages.
 *
 * Replaces `{{varName}}` placeholders with values from a context object.
 * Undefined variables produce `"<undefined:varName>"` sentinel strings.
 */

const TEMPLATE_RE = /\{\{(\w+)\}\}/g;

/**
 * Interpolates `{{varName}}` placeholders in a template string.
 *
 * @param template - String with `{{varName}}` placeholders.
 * @param context - Key-value context for substitution.
 * @returns Interpolated string.
 */
export function interpolate(template: string, context: Readonly<Record<string, unknown>>): string {
  return template.replace(TEMPLATE_RE, (_match, key: string) => {
    const value = context[key];
    if (value === undefined) return `<undefined:${key}>`;
    return String(value);
  });
}
