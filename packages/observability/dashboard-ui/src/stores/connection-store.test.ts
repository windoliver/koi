import { beforeEach, describe, expect, test } from "bun:test";
import { useConnectionStore } from "./connection-store.js";

describe("connection-store", () => {
  beforeEach(() => {
    useConnectionStore.setState({ status: "disconnected" });
  });

  test("initial status is disconnected", () => {
    expect(useConnectionStore.getState().status).toBe("disconnected");
  });

  test("setStatus updates connection state", () => {
    const { setStatus } = useConnectionStore.getState();

    setStatus("connected");
    expect(useConnectionStore.getState().status).toBe("connected");

    setStatus("reconnecting");
    expect(useConnectionStore.getState().status).toBe("reconnecting");
  });
});
