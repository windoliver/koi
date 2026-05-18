import type { KoiError, Result } from "@koi/core";

export type DeviceCapabilityName = "location" | "motion" | "sms" | "push" | "camera" | "contacts";

export type LocationAccuracy = "high" | "balanced" | "low";

export interface LocationRequest {
  readonly accuracy?: LocationAccuracy | undefined;
}

export interface LocationReading {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeMeters?: number | undefined;
  readonly accuracyMeters?: number | undefined;
  readonly timestampMs: number;
}

export interface LocationSensorComponent {
  readonly getCurrentPosition: (
    request?: LocationRequest,
  ) => Promise<Result<LocationReading, KoiError>>;
}

export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RotationRate {
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
}

export interface MotionReading {
  readonly acceleration: Vector3;
  readonly rotationRate: RotationRate;
  readonly timestampMs: number;
}

export interface MotionSensorComponent {
  readonly read: () => Promise<Result<MotionReading, KoiError>>;
  readonly watch: (listener: (reading: MotionReading) => void) => () => void;
}

export interface SmsSendRequest {
  readonly to: string;
  readonly body: string;
}

export interface SmsSendReceipt {
  readonly id: string;
  readonly to: string;
  readonly sentAtMs: number;
}

export interface SmsInboundMessage {
  readonly id: string;
  readonly from: string;
  readonly body: string;
  readonly receivedAtMs: number;
}

export interface SmsChannelComponent {
  readonly sendSms: (message: SmsSendRequest) => Promise<Result<SmsSendReceipt, KoiError>>;
  readonly onSms: (listener: (message: SmsInboundMessage) => void) => () => void;
}

export interface PushSendRequest {
  readonly recipient: string;
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, string>> | undefined;
}

export interface PushDeliveryReceipt {
  readonly id: string;
  readonly recipient: string;
  readonly deliveredAtMs: number;
}

export interface PushInboundNotification {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly receivedAtMs: number;
  readonly data?: Readonly<Record<string, string>> | undefined;
}

export interface PushChannelComponent {
  readonly sendPush: (message: PushSendRequest) => Promise<Result<PushDeliveryReceipt, KoiError>>;
  readonly onPush: (listener: (message: PushInboundNotification) => void) => () => void;
}

export type CameraMode = "photo" | "video";
export type CameraFacing = "front" | "back";

export interface CameraCaptureRequest {
  readonly mode?: CameraMode | undefined;
  readonly facing?: CameraFacing | undefined;
}

export interface CameraCapture {
  readonly mediaType: string;
  readonly data: Uint8Array;
  readonly capturedAtMs: number;
}

export interface CameraComponent {
  readonly capture: (request?: CameraCaptureRequest) => Promise<Result<CameraCapture, KoiError>>;
}

export interface ContactsListRequest {
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ContactEntry {
  readonly id: string;
  readonly displayName: string;
  readonly phoneNumbers: readonly string[];
  readonly emailAddresses: readonly string[];
}

export interface ContactsComponent {
  readonly list: (
    request?: ContactsListRequest,
  ) => Promise<Result<readonly ContactEntry[], KoiError>>;
}

export interface DeviceProviderConfig {
  readonly location?: LocationSensorComponent | undefined;
  readonly motion?: MotionSensorComponent | undefined;
  readonly sms?: SmsChannelComponent | undefined;
  readonly push?: PushChannelComponent | undefined;
  readonly camera?: CameraComponent | undefined;
  readonly contacts?: ContactsComponent | undefined;
  readonly priority?: number | undefined;
}

export interface LocationProviderConfig {
  readonly location?: LocationSensorComponent | undefined;
  readonly priority?: number | undefined;
}

export interface MotionProviderConfig {
  readonly motion?: MotionSensorComponent | undefined;
  readonly priority?: number | undefined;
}

export interface SmsProviderConfig {
  readonly sms?: SmsChannelComponent | undefined;
  readonly priority?: number | undefined;
}

export interface PushProviderConfig {
  readonly push?: PushChannelComponent | undefined;
  readonly priority?: number | undefined;
}

export interface CameraProviderConfig {
  readonly camera?: CameraComponent | undefined;
  readonly priority?: number | undefined;
}

export interface ContactsProviderConfig {
  readonly contacts?: ContactsComponent | undefined;
  readonly priority?: number | undefined;
}
