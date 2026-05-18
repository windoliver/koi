import { describe, expect, test } from "bun:test";
import { computeTrustScore } from "./trust-score.js";
import { mapVirusTotalAnalysisToSignal } from "./virustotal.js";

describe("VirusTotal and trust scoring", () => {
  test("VirusTotal malicious verdict maps to a blocking signal", () => {
    const signal = mapVirusTotalAnalysisToSignal({
      id: "analysis-1",
      status: "completed",
      stats: { harmless: 3, malicious: 1, suspicious: 0, undetected: 10, timeout: 0 },
      permalink: "https://www.virustotal.com/gui/file/example",
      scannedAt: 1,
    });

    expect(signal.verdict).toBe("malicious");
    expect(signal.passed).toBe(false);
    expect(signal.score).toBe(0);
  });

  test("trust score incorporates provenance, scans, publisher identity, and community signals", () => {
    const trusted = computeTrustScore({
      provenance: { verified: true, expired: false },
      localScan: { passed: true, score: 92 },
      virusTotal: { passed: true, verdict: "clean", score: 98 },
      publisher: { verified: true },
      community: { score: 0.8, feedbackCount: 12 },
    });
    const untrusted = computeTrustScore({
      provenance: { verified: false, expired: false },
      localScan: { passed: false, score: 20 },
      virusTotal: { passed: false, verdict: "malicious", score: 0 },
      publisher: { verified: false },
      community: { score: 0.2, feedbackCount: 2 },
    });

    expect(trusted.score).toBeGreaterThan(85);
    expect(trusted.level).toBe("verified");
    expect(trusted.signals.publisherIdentity).toBe("verified");
    expect(untrusted.score).toBeLessThan(30);
    expect(untrusted.level).toBe("blocked");
    expect(untrusted.signals.virusTotal).toBe("malicious");
  });

  test("publisher identity does not raise trust unless explicitly verified", () => {
    const withoutPublisher = computeTrustScore({
      provenance: { verified: true, expired: false },
      localScan: { passed: true, score: 90 },
      virusTotal: { passed: true, verdict: "clean", score: 90 },
      publisher: { verified: false },
      community: { score: 0.9, feedbackCount: 25 },
    });
    const withPublisher = computeTrustScore({
      provenance: { verified: true, expired: false },
      localScan: { passed: true, score: 90 },
      virusTotal: { passed: true, verdict: "clean", score: 90 },
      publisher: { verified: true },
      community: { score: 0.9, feedbackCount: 25 },
    });

    expect(withPublisher.score).toBeGreaterThan(withoutPublisher.score);
    expect(withoutPublisher.signals.publisherIdentity).toBe("unverified");
  });
});
