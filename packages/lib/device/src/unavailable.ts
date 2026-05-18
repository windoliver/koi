import type { JsonObject, KoiError } from "@koi/core";
import type { DeviceCapabilityName } from "./types.js";

export function createDeviceUnavailableError(capability: DeviceCapabilityName): KoiError {
  return {
    code: "UNAVAILABLE",
    message: `Device capability '${capability}' is not available on this node.`,
    retryable: false,
    context: {
      capability,
      source: "device",
    } satisfies JsonObject,
  };
}

export function isDeviceUnavailableError(error: KoiError): boolean {
  return error.code === "UNAVAILABLE" && error.context?.source === "device";
}
