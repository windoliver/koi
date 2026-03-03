/**
 * JSON schema grader — validates agent output against a schema.
 *
 * Simple recursive validation without external dependencies.
 */

import type { EngineEvent, EngineMetrics, JsonObject } from "@koi/core";
import { extractText } from "../transcript.js";
import type { EvalExpectation, EvalGrader, EvalScore } from "../types.js";

export interface JsonSchemaGraderConfig {
  readonly schema: JsonObject;
}

export function createJsonSchemaGrader(config: JsonSchemaGraderConfig): EvalGrader {
  return {
    id: "json-schema",
    name: "JSON Schema",
    grade(
      transcript: readonly EngineEvent[],
      _expected: EvalExpectation | undefined,
      _metrics: EngineMetrics,
    ): EvalScore {
      const text = extractText(transcript).trim();

      // Try to extract JSON from the output (may be wrapped in markdown code blocks)
      const jsonStr = extractJson(text);
      if (jsonStr === undefined) {
        return {
          graderId: "json-schema",
          score: 0,
          pass: false,
          reasoning: "Output is not valid JSON",
        };
      }

      // let justified: parse may throw
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        return {
          graderId: "json-schema",
          score: 0,
          pass: false,
          reasoning: "Failed to parse JSON from output",
        };
      }

      const errors = validateSchema(parsed, config.schema, "root");
      if (errors.length === 0) {
        return {
          graderId: "json-schema",
          score: 1,
          pass: true,
          reasoning: "Output matches JSON schema",
        };
      }

      return {
        graderId: "json-schema",
        score: 0,
        pass: false,
        reasoning: `Schema validation failed: ${errors.join("; ")}`,
      };
    },
  };
}

/**
 * Extracts a JSON string from text, handling markdown code blocks.
 */
function extractJson(text: string): string | undefined {
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (codeBlockMatch?.[1] !== undefined) {
    return codeBlockMatch[1].trim();
  }

  // Try the raw text as-is — could be any valid JSON value
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return undefined;
}

/**
 * Simple recursive JSON schema validator.
 * Supports: type, properties, required, items, minimum, maximum, minLength, maxLength.
 */
function validateSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
): readonly string[] {
  const errors: string[] = [];

  if (schema.type !== undefined) {
    const expected = schema.type;
    const actual = getJsonType(value);
    if (expected === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push(`${path}: expected integer, got ${actual}`);
        return errors;
      }
    } else if (actual !== expected) {
      errors.push(`${path}: expected ${String(expected)}, got ${actual}`);
      return errors;
    }
  }

  if (schema.type === "object" && typeof value === "object" && value !== null) {
    const obj = value as Readonly<Record<string, unknown>>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required as readonly string[]) {
        if (!(key in obj)) {
          errors.push(`${path}.${key}: required property missing`);
        }
      }
    }

    const properties = schema.properties;
    if (typeof properties === "object" && properties !== null) {
      const props = properties as Readonly<Record<string, unknown>>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj && typeof propSchema === "object" && propSchema !== null) {
          const subErrors = validateSchema(
            obj[key],
            propSchema as Readonly<Record<string, unknown>>,
            `${path}.${key}`,
          );
          for (const e of subErrors) errors.push(e);
        }
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value)) {
    const items = schema.items;
    if (typeof items === "object" && items !== null) {
      const itemSchema = items as Readonly<Record<string, unknown>>;
      for (const [i, item] of value.entries()) {
        const subErrors = validateSchema(item, itemSchema, `${path}[${String(i)}]`);
        for (const e of subErrors) errors.push(e);
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: ${String(value)} < minimum ${String(schema.minimum)}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: ${String(value)} > maximum ${String(schema.maximum)}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(
        `${path}: string length ${String(value.length)} < minLength ${String(schema.minLength)}`,
      );
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(
        `${path}: string length ${String(value.length)} > maxLength ${String(schema.maxLength)}`,
      );
    }
  }

  return errors;
}

function getJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
