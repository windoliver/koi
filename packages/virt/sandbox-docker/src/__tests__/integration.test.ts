/**
 * Integration tests for @koi/sandbox-docker.
 *
 * These tests require a running Docker daemon. They are skipped by default
 * unless the DOCKER_INTEGRATION environment variable is set.
 */

import { describe, expect, test } from "bun:test";
import { createDockerAdapter } from "../adapter.js";

const SKIP = !process.env.DOCKER_INTEGRATION;

describe.skipIf(SKIP)("Docker integration", () => {
  test("placeholder — requires Docker daemon", () => {
    // This test validates that the adapter factory works with default config.
    // Actual container creation requires an injected DockerClient backed by
    // the Docker Engine API (/var/run/docker.sock).
    const result = createDockerAdapter({});
    expect(result.ok).toBe(true);
  });
});
