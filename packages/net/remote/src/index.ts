export { verifyRemoteJwt } from "./jwt.js";
export type { TrustedDeviceRecord, TrustedDeviceRegistry } from "./trusted-device.js";
export { createInMemoryTrustedDeviceRegistry } from "./trusted-device.js";
export type {
  RemoteJwtClaims,
  RemoteJwtRejectReason,
  RemoteJwtVerifierOptions,
  RemoteJwtVerifyResult,
} from "./types.js";
