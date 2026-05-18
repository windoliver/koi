import type { BrickArtifact } from "@koi/core";

export type VirusTotalVerdict = "clean" | "suspicious" | "malicious" | "unknown";

export interface VirusTotalStats {
  readonly harmless: number;
  readonly malicious: number;
  readonly suspicious: number;
  readonly undetected: number;
  readonly timeout: number;
}

export interface VirusTotalAnalysis {
  readonly id: string;
  readonly status: "queued" | "completed" | "failed";
  readonly stats: VirusTotalStats;
  readonly permalink?: string | undefined;
  readonly scannedAt: number;
}

export interface VirusTotalSignal {
  readonly passed: boolean;
  readonly verdict: VirusTotalVerdict;
  readonly score: number;
  readonly analysisId: string;
  readonly permalink?: string | undefined;
  readonly scannedAt: number;
}

export interface VirusTotalClient {
  readonly scan: (content: Uint8Array) => Promise<VirusTotalAnalysis>;
}

export function mapVirusTotalAnalysisToSignal(analysis: VirusTotalAnalysis): VirusTotalSignal {
  const verdict: VirusTotalVerdict =
    analysis.status !== "completed"
      ? "unknown"
      : analysis.stats.malicious > 0
        ? "malicious"
        : analysis.stats.suspicious > 0
          ? "suspicious"
          : "clean";
  const score =
    verdict === "malicious" ? 0 : verdict === "suspicious" ? 40 : verdict === "clean" ? 100 : 50;
  return {
    passed: verdict === "clean",
    verdict,
    score,
    analysisId: analysis.id,
    ...(analysis.permalink !== undefined ? { permalink: analysis.permalink } : {}),
    scannedAt: analysis.scannedAt,
  };
}

function extractBrickContent(brick: BrickArtifact): string {
  if (brick.kind === "skill") return brick.content;
  if (brick.kind === "tool" || brick.kind === "middleware" || brick.kind === "channel") {
    return brick.implementation;
  }
  if (brick.kind === "agent") return brick.manifestYaml;
  if (brick.kind === "composite") {
    return JSON.stringify({
      steps: brick.steps,
      exposedInput: brick.exposedInput,
      exposedOutput: brick.exposedOutput,
      outputKind: brick.outputKind,
    });
  }
  return JSON.stringify({
    id: brick.id,
    kind: brick.kind,
    name: brick.name,
  });
}

export async function scanBrickWithVirusTotal(
  brick: BrickArtifact,
  client: VirusTotalClient,
): Promise<VirusTotalSignal> {
  const content = new TextEncoder().encode(extractBrickContent(brick));
  const analysis = await client.scan(content);
  return mapVirusTotalAnalysisToSignal(analysis);
}
