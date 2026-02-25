/**
 * Tool descriptor validation and optional handler invocation checks.
 *
 * Verifies that each tool has a valid descriptor (name, description, inputSchema)
 * and that mock handlers (when provided) return a valid ToolResponse.
 */

import type { JsonObject } from "@koi/core";
import { runCheck, skipCheck } from "../check-runner.js";
import type { CheckResult, SelfTestTool } from "../types.js";

const EMPTY_INPUT: JsonObject = {};

export async function runToolChecks(
  tools: readonly SelfTestTool[],
  checkTimeoutMs: number,
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];

  if (tools.length === 0) {
    results.push(skipCheck("tools: no tools to check", "tools", "No tools provided"));
    return results;
  }

  for (const tool of tools) {
    const { descriptor } = tool;

    // Descriptor: name is valid
    results.push(
      await runCheck(
        `tool[${descriptor.name}]: has valid name`,
        "tools",
        () => {
          if (typeof descriptor.name !== "string" || descriptor.name.trim().length === 0) {
            throw new Error("Tool descriptor name must be a non-empty string");
          }
        },
        checkTimeoutMs,
      ),
    );

    // Descriptor: description is present
    results.push(
      await runCheck(
        `tool[${descriptor.name}]: has description`,
        "tools",
        () => {
          if (
            typeof descriptor.description !== "string" ||
            descriptor.description.trim().length === 0
          ) {
            throw new Error("Tool descriptor description must be a non-empty string");
          }
        },
        checkTimeoutMs,
      ),
    );

    // Descriptor: inputSchema is an object
    results.push(
      await runCheck(
        `tool[${descriptor.name}]: has inputSchema`,
        "tools",
        () => {
          if (descriptor.inputSchema === undefined || descriptor.inputSchema === null) {
            throw new Error("Tool descriptor must have an inputSchema");
          }
          if (typeof descriptor.inputSchema !== "object") {
            throw new Error(
              `Tool descriptor inputSchema must be an object, got ${typeof descriptor.inputSchema}`,
            );
          }
        },
        checkTimeoutMs,
      ),
    );

    // Handler: returns valid ToolResponse (if provided)
    const { handler } = tool;
    if (handler !== undefined) {
      results.push(
        await runCheck(
          `tool[${descriptor.name}]: handler returns valid response`,
          "tools",
          async () => {
            const response = await handler(EMPTY_INPUT);
            if (response === undefined || response === null) {
              throw new Error("Tool handler returned undefined/null instead of ToolResponse");
            }
            if (!("output" in response)) {
              throw new Error("Tool handler response is missing 'output' field");
            }
          },
          checkTimeoutMs,
        ),
      );
    }
  }

  return results;
}
