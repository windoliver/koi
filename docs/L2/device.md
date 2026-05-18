# @koi/device

**Layer:** L2 · **Contract:** `ComponentProvider` + `SubsystemToken` (L0)

Device capability providers for thin mobile or desktop nodes. Hosts inject
platform implementations for GPS, motion sensors, SMS, native push, camera,
and contacts; Koi receives stable ECS components under the issue #1394 token
names.

## What it owns

- Stable capability tokens:
  - `sensor:location`
  - `sensor:motion`
  - `channel:sms`
  - `channel:push`
  - `tool:camera`
  - `tool:contacts`
- Typed component interfaces for each capability
- `createDeviceComponentProvider()` aggregate provider
- Per-capability providers for hosts that want to advertise a smaller set
- Typed `UNAVAILABLE` errors when a platform capability is not injected

## What it does NOT own

- Native iOS, Android, desktop, browser, or OS API calls
- Permission prompts or OS-level consent UX
- Gateway connection and network capability advertising
- Durable delivery, retry, or fan-out for SMS or push messages

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `ComponentProvider`, `SubsystemToken`, `Result`, `KoiError` |

## API

### `createDeviceComponentProvider(config)`

Registers all six capability keys. Missing implementations are filled with
fallback components that return `UNAVAILABLE` errors from fallible operations,
so callers can depend on stable component presence and still fail with typed
errors on unsupported devices.
Stream subscriptions for motion, SMS, and push also return a `Result`, so an
unavailable device can fail at subscription time instead of silently installing
a no-op listener.

### Per-Capability Providers

Use these when a host wants to advertise capabilities one at a time:

| Factory | Token |
|---------|-------|
| `createLocationProvider(config)` | `sensor:location` |
| `createMotionProvider(config)` | `sensor:motion` |
| `createSmsProvider(config)` | `channel:sms` |
| `createPushProvider(config)` | `channel:push` |
| `createCameraProvider(config)` | `tool:camera` |
| `createContactsProvider(config)` | `tool:contacts` |

### Unavailable Errors

`createDeviceUnavailableError(capability)` returns a `KoiError` with:

```ts
{
  code: "UNAVAILABLE",
  retryable: false,
  context: { source: "device", capability }
}
```

`isDeviceUnavailableError(error)` checks that shape for callers that need to
branch on unsupported platform features.
