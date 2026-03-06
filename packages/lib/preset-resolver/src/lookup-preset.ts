/**
 * Preset name resolution with default fallback.
 */

/**
 * Looks up a preset from a frozen registry, falling back to a default.
 *
 * Returns the resolved preset name and its specification.
 */
export function lookupPreset<P extends string, S>(
  specs: Readonly<Record<P, S>>,
  preset: P | undefined,
  defaultPreset: NoInfer<P>,
): { readonly preset: P; readonly spec: Readonly<S> } {
  const resolved = preset ?? defaultPreset;
  const spec = specs[resolved];
  return { preset: resolved, spec };
}
