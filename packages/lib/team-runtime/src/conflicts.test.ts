import { expect, test } from "bun:test";
import { compareVectorClock, detectWriteConflict } from "./conflicts.js";
import {
  createResourceSerializer,
  serializeSharedResource,
  serializeSharedResources,
} from "./workspace.js";

test("marks concurrent writes to the same resource as conflicts", () => {
  expect(
    detectWriteConflict(
      { resource: "package-lock.json", vectorClock: { agent_a: 1 } },
      { resource: "package-lock.json", vectorClock: { agent_b: 1 } },
    ),
  ).toBe(true);
});

test("does not mark ordered writes or different resources as conflicts", () => {
  expect(
    detectWriteConflict(
      { resource: "package-lock.json", vectorClock: { agent_a: 1 } },
      { resource: "package-lock.json", vectorClock: { agent_a: 2 } },
    ),
  ).toBe(false);

  expect(
    detectWriteConflict(
      { resource: "package-lock.json", vectorClock: { agent_a: 1 } },
      { resource: "README.md", vectorClock: { agent_b: 1 } },
    ),
  ).toBe(false);
});

test("ignores blank or whitespace-only resource keys when detecting conflicts", () => {
  expect(
    detectWriteConflict(
      { resource: "   ", vectorClock: { agent_a: 1 } },
      { resource: "", vectorClock: { agent_b: 1 } },
    ),
  ).toBe(false);
});

test("classifies disjoint vector clocks as concurrent", () => {
  expect(compareVectorClock({ agent_a: 1 }, { agent_b: 1 })).toBe("concurrent");
});

test("serializes shared resource keys consistently", () => {
  expect(serializeSharedResource(" package-lock.json ")).toBe("package-lock.json");
  expect(serializeSharedResources([" README.md ", "package-lock.json", "README.md", ""])).toEqual([
    "README.md",
    "package-lock.json",
  ]);
});

test("serializes access to shared resources with a simple lock set", () => {
  const serializer = createResourceSerializer(["package-lock.json"]);

  expect(serializer.isLocked("package-lock.json")).toBe(true);
  expect(serializer.acquire("package-lock.json")).toBe(false);
  expect(serializer.acquire(" README.md ")).toBe(true);
  expect(serializer.isLocked("README.md")).toBe(true);
  expect(serializer.snapshot()).toEqual(["README.md", "package-lock.json"]);
  serializer.release(" README.md ");
  expect(serializer.isLocked("README.md")).toBe(false);
  expect(serializer.acquire("   ")).toBe(false);
});
