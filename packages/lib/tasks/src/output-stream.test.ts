import { describe, expect, test } from "bun:test";
import { createOutputStream } from "./output-stream.js";

describe("createOutputStream", () => {
  test("write then read from offset 0 returns all content", () => {
    const stream = createOutputStream();
    stream.write("hello ");
    stream.write("world");

    const chunks = stream.read(0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.content).toBe("hello ");
    expect(chunks[0]?.offset).toBe(0);
    expect(chunks[1]?.content).toBe("world");
    expect(chunks[1]?.offset).toBe(6);
  });

  test("read from mid-offset returns only content after that offset", () => {
    const stream = createOutputStream();
    stream.write("aaa"); // offset 0, length 3
    stream.write("bbb"); // offset 3, length 3
    stream.write("ccc"); // offset 6, length 3

    const chunks = stream.read(3);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.content).toBe("bbb");
    expect(chunks[1]?.content).toBe("ccc");
  });

  test("read from offset beyond end returns empty", () => {
    const stream = createOutputStream();
    stream.write("abc");

    const chunks = stream.read(100);
    expect(chunks).toHaveLength(0);
  });

  test("length reflects total bytes written", () => {
    const stream = createOutputStream();
    expect(stream.length()).toBe(0);

    stream.write("hello");
    expect(stream.length()).toBe(5);

    stream.write(" world");
    expect(stream.length()).toBe(11);
  });

  test("subscribe receives new chunks as they arrive", () => {
    const stream = createOutputStream();
    const received: Array<{ readonly offset: number; readonly content: string }> = [];

    stream.subscribe((chunk) => {
      received.push(chunk);
    });

    stream.write("first");
    stream.write("second");

    expect(received).toHaveLength(2);
    expect(received[0]?.content).toBe("first");
    expect(received[0]?.offset).toBe(0);
    expect(received[1]?.content).toBe("second");
    expect(received[1]?.offset).toBe(5);
  });

  test("unsubscribe stops notifications", () => {
    const stream = createOutputStream();
    const received: string[] = [];

    const unsub = stream.subscribe((chunk) => {
      received.push(chunk.content);
    });

    stream.write("before");
    unsub();
    stream.write("after");

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("before");
  });

  test("multiple subscribers receive independently", () => {
    const stream = createOutputStream();
    const a: string[] = [];
    const b: string[] = [];

    stream.subscribe((chunk) => a.push(chunk.content));
    stream.subscribe((chunk) => b.push(chunk.content));

    stream.write("data");

    expect(a).toEqual(["data"]);
    expect(b).toEqual(["data"]);
  });

  test("memory cap evicts oldest chunks", () => {
    // 30 byte cap
    const stream = createOutputStream({ maxBytes: 30 });

    stream.write("aaaaaaaaaa"); // 10 bytes, offset 0
    stream.write("bbbbbbbbbb"); // 10 bytes, offset 10
    stream.write("cccccccccc"); // 10 bytes, offset 20 — total 30, at cap

    // Write 10 more — should evict the first chunk
    stream.write("dddddddddd"); // 10 bytes, offset 30 — evicts "aaa..."

    // Total length still tracks all bytes ever written
    expect(stream.length()).toBe(40);

    // Reading from 0 should start from earliest available (offset 10)
    const chunks = stream.read(0);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.offset).toBeGreaterThanOrEqual(10);
  });

  test("read from evicted offset returns from earliest available", () => {
    const stream = createOutputStream({ maxBytes: 20 });

    stream.write("aaaaaaaaaa"); // 10 bytes
    stream.write("bbbbbbbbbb"); // 10 bytes — at cap
    stream.write("cccccccccc"); // 10 bytes — evicts first

    // Offset 0 was evicted, should return from earliest available
    const chunks = stream.read(5);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All returned chunks should have offset >= 10 (earliest available)
    for (const chunk of chunks) {
      expect(chunk.offset).toBeGreaterThanOrEqual(10);
    }
  });

  test("chunks have increasing timestamps", () => {
    const stream = createOutputStream();
    stream.write("a");
    stream.write("b");

    const chunks = stream.read(0);
    // biome-ignore lint/style/noNonNullAssertion: test — two chunks guaranteed by writes above
    expect(chunks[0]!.timestamp).toBeLessThanOrEqual(chunks[1]!.timestamp);
  });

  test("dispose clears internal state", () => {
    const stream = createOutputStream();
    stream.write("data");
    stream[Symbol.dispose]();

    // After dispose, read returns empty
    expect(stream.read(0)).toHaveLength(0);
    expect(stream.length()).toBe(0);
  });
});
