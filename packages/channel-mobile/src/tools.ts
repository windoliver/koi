/**
 * Built-in mobile tool descriptors for native device capabilities.
 *
 * These descriptors define tools the agent can invoke on mobile clients.
 * The client receives tool_call frames and responds with tool_result frames.
 */

import type { ToolDescriptor } from "@koi/core";

/** Camera capture tool — requests a photo from the device camera. */
export const CAMERA_TOOL: ToolDescriptor = {
  name: "mobile_camera",
  description: "Capture a photo using the device camera.",
  inputSchema: {
    type: "object",
    properties: {
      facing: {
        type: "string",
        description: 'Camera facing direction: "front" or "back".',
        default: "back",
      },
    },
  },
  tags: ["mobile", "media"],
} as const;

/** GPS location tool — requests the device's current location. */
export const GPS_TOOL: ToolDescriptor = {
  name: "mobile_gps",
  description: "Get the current GPS coordinates of the device.",
  inputSchema: {
    type: "object",
    properties: {
      accuracy: {
        type: "string",
        description: 'Location accuracy: "high", "balanced", or "low".',
        default: "balanced",
      },
    },
  },
  tags: ["mobile", "location"],
} as const;

/** Haptic feedback tool — triggers vibration on the device. */
export const HAPTIC_TOOL: ToolDescriptor = {
  name: "mobile_haptic",
  description: "Trigger haptic feedback (vibration) on the device.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Vibration pattern: "light", "medium", "heavy", or "success".',
        default: "medium",
      },
    },
  },
  tags: ["mobile", "feedback"],
} as const;

/** All built-in mobile tools. */
export const DEFAULT_MOBILE_TOOLS: readonly ToolDescriptor[] = [
  CAMERA_TOOL,
  GPS_TOOL,
  HAPTIC_TOOL,
] as const;
