/**
 * Pipeline composition validation — structural schema compatibility
 * and pipeline step sequence validation.
 *
 * Used by compose_forge to validate that consecutive steps in a pipeline
 * have compatible I/O schemas before producing a CompositeArtifact.
 */

import type { PipelineStep } from "@koi/core";
import { MAX_PIPELINE_STEPS } from "@koi/core";

// ---------------------------------------------------------------------------
// Schema compatibility
// ---------------------------------------------------------------------------

/** Default maximum recursion depth for nested schema comparison. */
const DEFAULT_MAX_DEPTH = 10;

/** Result of a structural schema compatibility check. */
export interface SchemaCompatibility {
  readonly compatible: boolean;
  readonly errors: readonly string[];
}

/**
 * Check structural compatibility between a producer's output schema
 * and a consumer's input schema using JSON Schema subset rules.
 *
 * Rules:
 * - `type` must match (if both specify it)
 * - Consumer's `required` fields must all exist in producer's `properties`
 * - Nested `properties` types are compared recursively up to `maxDepth`
 * - Extra properties in the producer are allowed (open-world assumption)
 */
export function checkSchemaCompatibility(
  producer: Readonly<Record<string, unknown>>,
  consumer: Readonly<Record<string, unknown>>,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): SchemaCompatibility {
  const errors: string[] = [];
  checkSchemaCompat(producer, consumer, errors, "", maxDepth);
  return { compatible: errors.length === 0, errors };
}

function checkSchemaCompat(
  producer: Readonly<Record<string, unknown>>,
  consumer: Readonly<Record<string, unknown>>,
  errors: string[],
  path: string,
  depth: number,
): void {
  if (depth <= 0) {
    return;
  }

  // Type match
  if (producer.type !== undefined && consumer.type !== undefined) {
    if (producer.type !== consumer.type) {
      errors.push(
        `${path || "root"}: type mismatch — producer "${String(producer.type)}" vs consumer "${String(consumer.type)}"`,
      );
      return;
    }
  }

  // Required field subset check
  const consumerRequired = consumer.required;
  if (Array.isArray(consumerRequired)) {
    const producerProps = isRecord(producer.properties) ? producer.properties : {};
    for (const field of consumerRequired) {
      if (typeof field === "string" && !(field in producerProps)) {
        errors.push(
          `${path || "root"}: consumer requires "${field}" but producer does not provide it`,
        );
      }
    }
  }

  // Recursive property comparison
  const producerProps = producer.properties;
  const consumerProps = consumer.properties;
  if (isRecord(producerProps) && isRecord(consumerProps)) {
    for (const key of Object.keys(consumerProps)) {
      const consumerProp = consumerProps[key];
      const producerProp = producerProps[key];
      if (isRecord(consumerProp) && isRecord(producerProp)) {
        checkSchemaCompat(
          producerProp,
          consumerProp,
          errors,
          path ? `${path}.${key}` : key,
          depth - 1,
        );
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Pipeline validation
// ---------------------------------------------------------------------------

/** Result of pipeline validation. */
export interface PipelineValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate a pipeline of steps for structural correctness.
 *
 * Checks:
 * - At least 2 steps
 * - At most MAX_PIPELINE_STEPS steps
 * - Consecutive steps have compatible schemas (output[i] → input[i+1])
 * - Reports all errors (not just the first)
 */
export function validatePipeline(steps: readonly PipelineStep[]): PipelineValidation {
  const errors: string[] = [];

  if (steps.length < 2) {
    errors.push("Pipeline requires at least 2 steps");
  }

  if (steps.length > MAX_PIPELINE_STEPS) {
    errors.push(`Pipeline exceeds maximum of ${MAX_PIPELINE_STEPS} steps (got ${steps.length})`);
  }

  // Check consecutive schema compatibility
  for (let i = 0; i < steps.length - 1; i++) {
    const current = steps[i];
    const next = steps[i + 1];
    if (current === undefined || next === undefined) continue;

    const compat = checkSchemaCompatibility(current.outputPort.schema, next.inputPort.schema);

    if (!compat.compatible) {
      for (const error of compat.errors) {
        errors.push(`Step ${i}→${i + 1}: ${error}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
