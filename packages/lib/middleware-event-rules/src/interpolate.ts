/**
 * Shallow `{{var}}` template interpolation.
 *
 * Replaces placeholders with values from a context object.
 * Undefined variables produce `<undefined:varName>` sentinel strings.
 */

const TEMPLATE_RE = /\{\{(\w+)\}\}/g;

export function interpolate(template: string, context: Readonly<Record<string, unknown>>): string {
  return template.replace(TEMPLATE_RE, (_match, key: string) => {
    const value = context[key];
    if (value === undefined) return `<undefined:${key}>`;
    return String(value);
  });
}
