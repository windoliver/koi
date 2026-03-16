/**
 * Pure validators for wizard inputs.
 *
 * Extracted from CLI wizard/steps.ts for sharing with TUI.
 */

/** Regex for valid agent names: lowercase alphanumeric, hyphens, dots, underscores. */
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Check if a name is valid. */
export function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && VALID_NAME_RE.test(name);
}

/** Validate a name, returning an error string or undefined. */
export function validateName(name: string): string | undefined {
  if (name.length === 0) return "Name cannot be empty";
  if (name.length > 214) return "Name must be 214 characters or fewer";
  if (!VALID_NAME_RE.test(name))
    return "Use lowercase alphanumeric characters, hyphens, dots, or underscores (must start with alphanumeric)";
  return undefined;
}

/** Check if a model string has valid format (provider:model). */
export function isValidModel(name: string): boolean {
  const colonIndex = name.indexOf(":");
  if (colonIndex <= 0 || colonIndex === name.length - 1) {
    return false;
  }
  return true;
}

/** Validate a model string, returning an error string or undefined. */
export function validateModel(model: string): string | undefined {
  if (model.length === 0) return "Model cannot be empty";
  const colonIndex = model.indexOf(":");
  if (colonIndex <= 0) return "Model must be in 'provider:model' format";
  if (colonIndex === model.length - 1) return "Model name cannot be empty after provider";
  return undefined;
}
