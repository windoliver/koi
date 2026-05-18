import { describe, expect, test } from "bun:test";
import {
  createNeuroSkillSensor,
  type NeuroSkillSocket,
  type NeuroSkillSocketFactory,
} from "./neuroskill-sensor.js";

interface FakeSocket extends NeuroSkillSocket {
  readonly emitMessage: (data: string) => void;
  readonly emitClose: () => void;
}

function createFakeSocket(): {
  readonly factory: NeuroSkillSocketFactory;
  readonly sockets: readonly FakeSocket[];
} {
  const sockets: FakeSocket[] = [];

  const factory: NeuroSkillSocketFactory = () => {
    let messageHandler: ((event: { readonly data: string }) => void) | undefined;
    let closeHandler: ((event: { readonly data?: unknown }) => void) | undefined;

    const socket: FakeSocket = {
      close() {
        closeHandler?.({});
      },
      addEventListener(type, handler) {
        if (type === "message") messageHandler = handler;
        if (type === "close") closeHandler = handler;
      },
      emitMessage(data) {
        messageHandler?.({ data });
      },
      emitClose() {
        closeHandler?.({});
      },
    };

    sockets.push(socket);
    return socket;
  };

  return { factory, sockets };
}

const attentiveFrame = {
  timestamp: 1_000,
  samplingRateHz: 128,
  channels: [
    {
      name: "eeg.fz",
      type: "eeg",
      samples: [0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1],
    },
  ],
} as const;

describe("createNeuroSkillSensor", () => {
  test("receives a WebSocket BCI stream and emits a state update immediately", () => {
    const { factory, sockets } = createFakeSocket();
    const sensor = createNeuroSkillSensor({ socketFactory: factory });
    const states: unknown[] = [];

    sensor.subscribe((event) => {
      states.push(event);
    });

    sensor.connect("ws://localhost:8765/exg");
    sockets[0]?.emitMessage(JSON.stringify(attentiveFrame));

    expect(sensor.snapshot().connectionState).toBe("connected");
    expect(states).toHaveLength(1);
    expect(sensor.snapshot().cognitiveState.attention).toBeGreaterThan(0.5);
  });

  test("preprocessing rejects outlier noise from feature extraction", () => {
    const sensor = createNeuroSkillSensor({ now: () => 2_000 });

    sensor.record({
      timestamp: 1_000,
      samplingRateHz: 128,
      channels: [
        {
          name: "eeg.fz",
          type: "eeg",
          samples: [1, 1, 1, 1, 1, 1, 250, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        },
      ],
    });

    const channel = sensor.snapshot().latestFeatures.channels[0];
    expect(channel?.noiseRejectedSamples).toBe(1);
    expect(channel?.peakAmplitude).toBeLessThan(30);
  });

  test("estimates fatigue from theta-heavy EEG features", () => {
    const sensor = createNeuroSkillSensor({ now: () => 2_000 });

    sensor.record({
      timestamp: 1_000,
      samplingRateHz: 64,
      channels: [
        {
          name: "eeg.fz",
          type: "eeg",
          samples: [
            0, 0.38, 0.7, 0.92, 1, 0.92, 0.7, 0.38, 0, -0.38, -0.7, -0.92, -1, -0.92, -0.7, -0.38,
          ],
        },
      ],
    });

    const state = sensor.snapshot().cognitiveState;
    expect(state.fatigue).toBeGreaterThan(state.attention);
    expect(state.confidence).toBeGreaterThan(0);
  });

  test("event stream delivers state updates and bounds retained events", () => {
    const sensor = createNeuroSkillSensor({ now: () => 3_000, maxEvents: 2 });
    const seen: string[] = [];

    sensor.subscribe((event) => {
      seen.push(event.kind);
    });

    sensor.record({ ...attentiveFrame, timestamp: 1_000 });
    sensor.record({ ...attentiveFrame, timestamp: 2_000 });
    sensor.record({ ...attentiveFrame, timestamp: 3_000 });

    expect(seen).toEqual(["cognitive_state", "cognitive_state", "cognitive_state"]);
    expect(sensor.snapshot().recentEvents).toEqual([
      { kind: "cognitive_state", timestamp: 2_000 },
      { kind: "cognitive_state", timestamp: 3_000 },
    ]);
  });

  test("connection loss is reflected without clearing the last state", () => {
    const { factory, sockets } = createFakeSocket();
    const sensor = createNeuroSkillSensor({ socketFactory: factory });

    sensor.connect("ws://localhost:8765/exg");
    sockets[0]?.emitMessage(JSON.stringify(attentiveFrame));
    sockets[0]?.emitClose();

    const snapshot = sensor.snapshot();
    expect(snapshot.connectionState).toBe("disconnected");
    expect(snapshot.cognitiveState.attention).toBeGreaterThan(0);
  });

  test("signal validation rejects malformed data", () => {
    const { factory, sockets } = createFakeSocket();
    const sensor = createNeuroSkillSensor({ socketFactory: factory });
    const seen: unknown[] = [];

    sensor.subscribe((event) => {
      seen.push(event);
    });

    sensor.connect("ws://localhost:8765/exg");
    sockets[0]?.emitMessage(JSON.stringify({ timestamp: 1, channels: [] }));
    sockets[0]?.emitMessage("{not-json");

    expect(sensor.snapshot().rejectedFrames).toBe(2);
    expect(seen).toEqual([]);
  });

  test("signal validation rejects channels with non-finite samples", () => {
    const sensor = createNeuroSkillSensor({ now: () => 2_000 });

    expect(
      sensor.record({
        timestamp: 1_000,
        samplingRateHz: 128,
        channels: [{ name: "eeg.fz", type: "eeg", samples: [0, Number.NaN, 1] }],
      }),
    ).toBe(false);

    expect(sensor.snapshot()).toMatchObject({
      retainedEventCount: 0,
      rejectedFrames: 1,
    });
  });

  test("read returns a user-model sensor signal", () => {
    const sensor = createNeuroSkillSensor({ now: () => 60_000 });

    sensor.record(attentiveFrame);

    expect(sensor.name).toBe("neuroskill");
    expect(sensor.read()).toEqual({
      kind: "sensor",
      source: "neuroskill",
      values: sensor.snapshot(),
    });
  });

  test("read remains stable when passed as an unbound SignalSource callback", () => {
    const sensor = createNeuroSkillSensor({ now: () => 60_000 });
    sensor.record(attentiveFrame);

    const read = sensor.read;

    expect(read()).toEqual({
      kind: "sensor",
      source: "neuroskill",
      values: sensor.snapshot(),
    });
  });
});
