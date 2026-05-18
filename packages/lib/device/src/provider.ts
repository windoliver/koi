import type { Agent, AttachResult, ComponentProvider, KoiError, Result } from "@koi/core";
import { COMPONENT_PRIORITY } from "@koi/core";
import { CAMERA, CONTACTS, LOCATION, MOTION, PUSH, SMS } from "./tokens.js";
import type {
  CameraComponent,
  CameraProviderConfig,
  ContactsComponent,
  ContactsProviderConfig,
  DeviceProviderConfig,
  LocationProviderConfig,
  LocationSensorComponent,
  MotionProviderConfig,
  MotionSensorComponent,
  PushChannelComponent,
  PushProviderConfig,
  SmsChannelComponent,
  SmsProviderConfig,
} from "./types.js";
import { createDeviceUnavailableError } from "./unavailable.js";

function unavailableSubscription(
  capability: "motion" | "sms" | "push",
): Result<() => void, KoiError> {
  return {
    ok: false,
    error: createDeviceUnavailableError(capability),
  };
}

function unavailableLocation(): LocationSensorComponent {
  return {
    getCurrentPosition: async () => ({
      ok: false,
      error: createDeviceUnavailableError("location"),
    }),
  };
}

function unavailableMotion(): MotionSensorComponent {
  return {
    read: async () => ({
      ok: false,
      error: createDeviceUnavailableError("motion"),
    }),
    watch: () => unavailableSubscription("motion"),
  };
}

function unavailableSms(): SmsChannelComponent {
  return {
    sendSms: async () => ({
      ok: false,
      error: createDeviceUnavailableError("sms"),
    }),
    onSms: () => unavailableSubscription("sms"),
  };
}

function unavailablePush(): PushChannelComponent {
  return {
    sendPush: async () => ({
      ok: false,
      error: createDeviceUnavailableError("push"),
    }),
    onPush: () => unavailableSubscription("push"),
  };
}

function unavailableCamera(): CameraComponent {
  return {
    capture: async () => ({
      ok: false,
      error: createDeviceUnavailableError("camera"),
    }),
  };
}

function unavailableContacts(): ContactsComponent {
  return {
    list: async () => ({
      ok: false,
      error: createDeviceUnavailableError("contacts"),
    }),
  };
}

function attachSingle(
  tokenKey: string,
  component: unknown,
): (agent: Agent) => Promise<AttachResult> {
  return async () => ({
    components: new Map<string, unknown>([[tokenKey, component]]),
    skipped: [],
  });
}

export function createLocationProvider(config: LocationProviderConfig): ComponentProvider {
  return {
    name: "device:location",
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
    attach: attachSingle(LOCATION as string, config.location ?? unavailableLocation()),
  };
}

export function createMotionProvider(config: MotionProviderConfig): ComponentProvider {
  return {
    name: "device:motion",
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
    attach: attachSingle(MOTION as string, config.motion ?? unavailableMotion()),
  };
}

export function createSmsProvider(config: SmsProviderConfig): ComponentProvider {
  return {
    name: "device:sms",
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
    attach: attachSingle(SMS as string, config.sms ?? unavailableSms()),
  };
}

export function createPushProvider(config: PushProviderConfig): ComponentProvider {
  return {
    name: "device:push",
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
    attach: attachSingle(PUSH as string, config.push ?? unavailablePush()),
  };
}

export function createCameraProvider(config: CameraProviderConfig): ComponentProvider {
  return {
    name: "device:camera",
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
    attach: attachSingle(CAMERA as string, config.camera ?? unavailableCamera()),
  };
}

export function createContactsProvider(config: ContactsProviderConfig): ComponentProvider {
  return {
    name: "device:contacts",
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
    attach: attachSingle(CONTACTS as string, config.contacts ?? unavailableContacts()),
  };
}

export function createDeviceComponentProvider(config: DeviceProviderConfig): ComponentProvider {
  return {
    name: "device",
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
    async attach(_agent: Agent): Promise<AttachResult> {
      return {
        components: new Map<string, unknown>([
          [LOCATION as string, config.location ?? unavailableLocation()],
          [MOTION as string, config.motion ?? unavailableMotion()],
          [SMS as string, config.sms ?? unavailableSms()],
          [PUSH as string, config.push ?? unavailablePush()],
          [CAMERA as string, config.camera ?? unavailableCamera()],
          [CONTACTS as string, config.contacts ?? unavailableContacts()],
        ]),
        skipped: [],
      };
    },
  };
}
