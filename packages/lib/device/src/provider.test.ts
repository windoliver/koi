import { describe, expect, test } from "bun:test";
import type { Agent, KoiError, SubsystemToken } from "@koi/core";
import { agentId, COMPONENT_PRIORITY, isAttachResult } from "@koi/core";
import type {
  CameraComponent,
  ContactsComponent,
  DeviceProviderConfig,
  LocationSensorComponent,
  MotionSensorComponent,
  PushChannelComponent,
  SmsChannelComponent,
} from "./index.js";
import {
  CAMERA,
  CONTACTS,
  createCameraProvider,
  createContactsProvider,
  createDeviceComponentProvider,
  createDeviceUnavailableError,
  createLocationProvider,
  createMotionProvider,
  createPushProvider,
  createSmsProvider,
  isDeviceUnavailableError,
  LOCATION,
  MOTION,
  PUSH,
  SMS,
} from "./index.js";

function makeAgent(): Agent {
  return {
    pid: { id: agentId("device-test"), name: "device-test", type: "worker", depth: 0 },
    manifest: {
      name: "device-test",
      version: "1.0.0",
      model: { name: "test-model" },
      tools: [],
      channels: [],
      middleware: [],
    },
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

async function attachComponents(
  config: DeviceProviderConfig,
): Promise<ReadonlyMap<string, unknown>> {
  const result = await createDeviceComponentProvider(config).attach(makeAgent());
  expect(isAttachResult(result)).toBe(true);
  return isAttachResult(result) ? result.components : result;
}

function getComponent<T>(components: ReadonlyMap<string, unknown>, token: SubsystemToken<T>): T {
  const component = components.get(token as string);
  expect(component).toBeDefined();
  return component as T;
}

describe("device capability tokens", () => {
  test("use stable ECS token strings from issue 1394", () => {
    expect(LOCATION as string).toBe("sensor:location");
    expect(MOTION as string).toBe("sensor:motion");
    expect(SMS as string).toBe("channel:sms");
    expect(PUSH as string).toBe("channel:push");
    expect(CAMERA as string).toBe("tool:camera");
    expect(CONTACTS as string).toBe("tool:contacts");
  });
});

describe("createDeviceComponentProvider", () => {
  test("registers every device capability with bundled priority by default", async () => {
    const components = await attachComponents({
      location: {
        getCurrentPosition: async () => ({
          ok: true,
          value: { latitude: 37.7749, longitude: -122.4194, timestampMs: 1 },
        }),
      },
    });

    expect(createDeviceComponentProvider({}).name).toBe("device");
    expect(createDeviceComponentProvider({}).priority).toBe(COMPONENT_PRIORITY.BUNDLED);
    expect([...components.keys()]).toEqual([
      "sensor:location",
      "sensor:motion",
      "channel:sms",
      "channel:push",
      "tool:camera",
      "tool:contacts",
    ]);
  });

  test("respects caller-supplied priority override", () => {
    const provider = createDeviceComponentProvider({ priority: 25 });
    expect(provider.priority).toBe(25);
  });

  test("location provider returns GPS coordinates through the location component", async () => {
    const components = await attachComponents({
      location: {
        getCurrentPosition: async (request) => ({
          ok: true,
          value: {
            latitude: 47.6062,
            longitude: -122.3321,
            altitudeMeters: 42,
            accuracyMeters: request?.accuracy === "high" ? 5 : 50,
            timestampMs: 123,
          },
        }),
      },
    });

    const location = getComponent<LocationSensorComponent>(components, LOCATION);
    const result = await location.getCurrentPosition({ accuracy: "high" });

    expect(result).toEqual({
      ok: true,
      value: {
        latitude: 47.6062,
        longitude: -122.3321,
        altitudeMeters: 42,
        accuracyMeters: 5,
        timestampMs: 123,
      },
    });
  });

  test("motion provider reads and streams accelerometer data", async () => {
    // Reassigned by the watch callback so the test can assert delivery.
    let observedReading: Awaited<ReturnType<MotionSensorComponent["read"]>> | undefined;
    const components = await attachComponents({
      motion: {
        read: async () => ({
          ok: true,
          value: {
            acceleration: { x: 1, y: 2, z: 3 },
            rotationRate: { alpha: 4, beta: 5, gamma: 6 },
            timestampMs: 7,
          },
        }),
        watch: (listener) => {
          listener({
            acceleration: { x: 8, y: 9, z: 10 },
            rotationRate: { alpha: 11, beta: 12, gamma: 13 },
            timestampMs: 14,
          });
          return { ok: true, value: () => {} };
        },
      },
    });

    const motion = getComponent<MotionSensorComponent>(components, MOTION);
    const read = await motion.read();
    const subscription = motion.watch((reading) => {
      observedReading = { ok: true, value: reading };
    });

    expect(read.ok).toBe(true);
    expect(subscription.ok).toBe(true);
    expect(read.ok ? read.value.acceleration.x : 0).toBe(1);
    expect(observedReading?.ok).toBe(true);
    expect(observedReading?.ok ? observedReading.value.rotationRate.gamma : 0).toBe(13);
    if (subscription.ok) subscription.value();
  });

  test("SMS provider sends and receives SMS messages", async () => {
    const received = {
      id: "sms-2",
      from: "+15551230000",
      body: "hello",
      receivedAtMs: 20,
    };
    const components = await attachComponents({
      sms: {
        sendSms: async (message) => ({
          ok: true,
          value: { id: "sms-1", to: message.to, sentAtMs: 10 },
        }),
        onSms: (listener) => {
          listener(received);
          return { ok: true, value: () => {} };
        },
      },
    });

    const sms = getComponent<SmsChannelComponent>(components, SMS);
    const sent = await sms.sendSms({ to: "+15550001111", body: "ping" });
    // Reassigned by the receive callback so the test can assert delivery.
    let inbound: typeof received | undefined;
    const subscription = sms.onSms((message) => {
      inbound = message;
    });

    expect(sent).toEqual({ ok: true, value: { id: "sms-1", to: "+15550001111", sentAtMs: 10 } });
    expect(subscription.ok).toBe(true);
    expect(inbound).toEqual(received);
  });

  test("push provider delivers native push notifications", async () => {
    const received = {
      id: "push-2",
      title: "Hello",
      body: "Arrived",
      receivedAtMs: 35,
    };
    const components = await attachComponents({
      push: {
        sendPush: async (message) => ({
          ok: true,
          value: { id: "push-1", recipient: message.recipient, deliveredAtMs: 30 },
        }),
        onPush: (listener) => {
          listener(received);
          return { ok: true, value: () => {} };
        },
      },
    });

    const push = getComponent<PushChannelComponent>(components, PUSH);
    const result = await push.sendPush({
      recipient: "user-1",
      title: "Hi",
      body: "Ready",
    });
    let inbound: typeof received | undefined;
    const subscription = push.onPush((message) => {
      inbound = message;
    });

    expect(result).toEqual({
      ok: true,
      value: { id: "push-1", recipient: "user-1", deliveredAtMs: 30 },
    });
    expect(subscription.ok).toBe(true);
    expect(inbound).toEqual(received);
  });

  test("camera provider captures image data", async () => {
    const components = await attachComponents({
      camera: {
        capture: async (request) => ({
          ok: true,
          value: {
            mediaType: request?.mode === "video" ? "video/mp4" : "image/jpeg",
            data: new Uint8Array([1, 2, 3]),
            capturedAtMs: 40,
          },
        }),
      },
    });

    const camera = getComponent<CameraComponent>(components, CAMERA);
    const result = await camera.capture({ mode: "photo", facing: "back" });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.mediaType : "").toBe("image/jpeg");
    expect(result.ok ? [...result.value.data] : []).toEqual([1, 2, 3]);
  });

  test("contacts provider returns address book entries", async () => {
    const components = await attachComponents({
      contacts: {
        list: async () => ({
          ok: true,
          value: [
            {
              id: "contact-1",
              displayName: "Ada Lovelace",
              phoneNumbers: ["+15550101010"],
              emailAddresses: ["ada@example.com"],
            },
          ],
        }),
      },
    });

    const contacts = getComponent<ContactsComponent>(components, CONTACTS);
    const result = await contacts.list({ limit: 10 });

    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: "contact-1",
          displayName: "Ada Lovelace",
          phoneNumbers: ["+15550101010"],
          emailAddresses: ["ada@example.com"],
        },
      ],
    });
  });

  test("unavailable capabilities return typed UNAVAILABLE errors", async () => {
    const components = await attachComponents({});
    const location = getComponent<LocationSensorComponent>(components, LOCATION);
    const motion = getComponent<MotionSensorComponent>(components, MOTION);
    const sms = getComponent<SmsChannelComponent>(components, SMS);
    const push = getComponent<PushChannelComponent>(components, PUSH);
    const camera = getComponent<CameraComponent>(components, CAMERA);
    const contacts = getComponent<ContactsComponent>(components, CONTACTS);

    const locationResult = await location.getCurrentPosition();
    const motionResult = await motion.read();
    const smsResult = await sms.sendSms({ to: "+15550001111", body: "ping" });
    const pushResult = await push.sendPush({ recipient: "user-1", title: "Hi", body: "Ready" });
    const cameraResult = await camera.capture();
    const contactsResult = await contacts.list();
    const motionWatchResult = motion.watch(() => {});
    const smsSubscribeResult = sms.onSms(() => {});
    const pushSubscribeResult = push.onPush(() => {});

    expect(locationResult.ok).toBe(false);
    expect(motionResult.ok).toBe(false);
    expect(smsResult.ok).toBe(false);
    expect(pushResult.ok).toBe(false);
    expect(cameraResult.ok).toBe(false);
    expect(contactsResult.ok).toBe(false);
    expect(motionWatchResult).toEqual({
      ok: false,
      error: createDeviceUnavailableError("motion"),
    });
    expect(smsSubscribeResult).toEqual({
      ok: false,
      error: createDeviceUnavailableError("sms"),
    });
    expect(pushSubscribeResult).toEqual({
      ok: false,
      error: createDeviceUnavailableError("push"),
    });
    expect(isDeviceUnavailableError((locationResult as { readonly error: KoiError }).error)).toBe(
      true,
    );
    expect(isDeviceUnavailableError((motionResult as { readonly error: KoiError }).error)).toBe(
      true,
    );
    expect(isDeviceUnavailableError((smsResult as { readonly error: KoiError }).error)).toBe(true);
    expect(isDeviceUnavailableError((pushResult as { readonly error: KoiError }).error)).toBe(true);
    expect(isDeviceUnavailableError((cameraResult as { readonly error: KoiError }).error)).toBe(
      true,
    );
    expect(isDeviceUnavailableError((contactsResult as { readonly error: KoiError }).error)).toBe(
      true,
    );
  });
});

describe("individual device capability providers", () => {
  test("each provider registers only its own capability token", async () => {
    const providers = [
      createLocationProvider({}),
      createMotionProvider({}),
      createSmsProvider({}),
      createPushProvider({}),
      createCameraProvider({}),
      createContactsProvider({}),
    ] as const;

    const keys = await Promise.all(
      providers.map(async (provider) => {
        const result = await provider.attach(makeAgent());
        expect(isAttachResult(result)).toBe(true);
        return isAttachResult(result) ? [...result.components.keys()] : [];
      }),
    );

    expect(keys).toEqual([
      ["sensor:location"],
      ["sensor:motion"],
      ["channel:sms"],
      ["channel:push"],
      ["tool:camera"],
      ["tool:contacts"],
    ]);
  });
});
