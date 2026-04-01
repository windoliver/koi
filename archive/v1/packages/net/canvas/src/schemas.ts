/**
 * Module-private Zod schemas for A2UI messages.
 *
 * NOT exported from index.ts — consumed via validateA2ui*() functions.
 * Follows the @koi/config pattern: schemas are module-private, only
 * validation functions are exported.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const surfaceIdSchema = z.string().min(1);
const componentIdSchema = z.string().min(1);

const componentTypeSchema = z.union([
  // Layout
  z.literal("Row"),
  z.literal("Column"),
  z.literal("List"),
  z.literal("Card"),
  z.literal("Tabs"),
  z.literal("Modal"),
  // Display
  z.literal("Text"),
  z.literal("Image"),
  z.literal("Icon"),
  z.literal("Video"),
  z.literal("AudioPlayer"),
  z.literal("Divider"),
  // Input
  z.literal("TextField"),
  z.literal("CheckBox"),
  z.literal("DateTimeInput"),
  z.literal("ChoicePicker"),
  z.literal("Slider"),
  z.literal("Button"),
]);

// ---------------------------------------------------------------------------
// Component schema
// ---------------------------------------------------------------------------

const a2uiComponentSchema = z.object({
  id: componentIdSchema,
  type: componentTypeSchema,
  properties: z.record(z.string(), z.unknown()).optional(),
  children: z.array(componentIdSchema).optional(),
  dataBinding: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Data model update
// ---------------------------------------------------------------------------

const dataModelUpdateSchema = z.object({
  pointer: z.string().min(1),
  value: z.unknown(),
});

// ---------------------------------------------------------------------------
// A2UI message schemas (discriminated by `kind`)
// ---------------------------------------------------------------------------

const createSurfaceSchema = z.object({
  kind: z.literal("createSurface"),
  surfaceId: surfaceIdSchema,
  title: z.string().optional(),
  components: z.array(a2uiComponentSchema).min(1),
  dataModel: z.record(z.string(), z.unknown()).optional(),
});

const updateComponentsSchema = z.object({
  kind: z.literal("updateComponents"),
  surfaceId: surfaceIdSchema,
  components: z.array(a2uiComponentSchema).min(1),
});

const updateDataModelSchema = z.object({
  kind: z.literal("updateDataModel"),
  surfaceId: surfaceIdSchema,
  updates: z.array(dataModelUpdateSchema).min(1),
});

const deleteSurfaceSchema = z.object({
  kind: z.literal("deleteSurface"),
  surfaceId: surfaceIdSchema,
});

const a2uiMessageSchema = z.discriminatedUnion("kind", [
  createSurfaceSchema,
  updateComponentsSchema,
  updateDataModelSchema,
  deleteSurfaceSchema,
]);

// ---------------------------------------------------------------------------
// Validation functions (exported)
// ---------------------------------------------------------------------------

/** Validates raw input against the A2UI message discriminated union schema. */
export function validateA2uiMessageSchema(raw: unknown): Result<unknown, KoiError> {
  return validateWith(a2uiMessageSchema, raw, "A2UI message validation failed");
}

/** Validates raw input against the createSurface schema. */
export function validateCreateSurfaceSchema(raw: unknown): Result<unknown, KoiError> {
  return validateWith(createSurfaceSchema, raw, "createSurface validation failed");
}
