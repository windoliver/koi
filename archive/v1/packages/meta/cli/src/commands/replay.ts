/**
 * `koi replay` — Reconstruct and display agent state at a specific turn.
 *
 * Usage: koi replay --session <id> --turn <N> [--db <path>] [--events]
 *
 * Opens the SQLite snapshot chain store at the given db path (default:
 * `.koi/snapshots.db`), lists snapshots for the session chain, finds the
 * snapshot at the specified turn index, and displays its details.
 */

import type { ChainId, SnapshotNode } from "@koi/core";
import { chainId } from "@koi/core";
import { createSqliteSnapshotChainStore } from "@koi/snapshot-chain-store";
import type { ReplayFlags } from "../args.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function formatDataSummary(data: unknown): string {
  const json = JSON.stringify(data);
  // Truncate long data for display
  const MAX_LENGTH = 200;
  if (json.length <= MAX_LENGTH) return json;
  return `${json.slice(0, MAX_LENGTH)}...`;
}

function printNode(node: SnapshotNode<unknown>, turnIndex: number, showEvents: boolean): void {
  process.stdout.write(`Turn:         ${String(turnIndex)}\n`);
  process.stdout.write(`Node ID:      ${node.nodeId}\n`);
  process.stdout.write(`Chain ID:     ${node.chainId}\n`);
  process.stdout.write(`Timestamp:    ${formatTimestamp(node.createdAt)}\n`);
  process.stdout.write(`Content Hash: ${node.contentHash}\n`);
  process.stdout.write(
    `Parent IDs:   ${node.parentIds.length > 0 ? node.parentIds.join(", ") : "(root)"}\n`,
  );

  const metaKeys = Object.keys(node.metadata);
  if (metaKeys.length > 0) {
    process.stdout.write(`Metadata:     ${JSON.stringify(node.metadata)}\n`);
  } else {
    process.stdout.write("Metadata:     {}\n");
  }

  process.stdout.write(`Data:         ${formatDataSummary(node.data)}\n`);

  if (showEvents) {
    const meta = node.metadata as Readonly<Record<string, unknown>>;
    const events = meta.events;
    if (events !== undefined) {
      process.stdout.write(`\nEvent trace:\n${JSON.stringify(events, null, 2)}\n`);
    } else {
      process.stdout.write("\nNo event trace data in metadata.\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runReplay(flags: ReplayFlags): Promise<void> {
  const { session, turn, db: dbPath, events } = flags;

  if (session === undefined) {
    process.stderr.write("Error: --session <id> is required.\n");
    process.stderr.write("Usage: koi replay --session <id> --turn <N> [--db <path>] [--events]\n");
    process.exit(1);
  }

  if (turn === undefined) {
    process.stderr.write("Error: --turn <N> is required.\n");
    process.stderr.write("Usage: koi replay --session <id> --turn <N> [--db <path>] [--events]\n");
    process.exit(1);
  }

  const resolvedDbPath = dbPath ?? ".koi/snapshots.db";
  const store = createSqliteSnapshotChainStore<unknown>(resolvedDbPath);

  try {
    const cid: ChainId = chainId(session);
    const listResult = await store.list(cid);

    if (!listResult.ok) {
      process.stderr.write(`Failed to list snapshots: ${listResult.error.message}\n`);
      process.exit(1);
    }

    const nodes = listResult.value;

    if (nodes.length === 0) {
      process.stderr.write(`No snapshots found for session "${session}".\n`);
      process.exit(1);
    }

    // Nodes are newest-first; reverse to get oldest-first for turn indexing
    const chronological = [...nodes].reverse();

    if (turn < 0 || turn >= chronological.length) {
      process.stderr.write(
        `Turn ${String(turn)} out of range. Session has ${String(chronological.length)} turns (0-${String(chronological.length - 1)}).\n`,
      );
      process.exit(1);
    }

    const targetNode = chronological[turn];
    if (targetNode === undefined) {
      process.stderr.write(`Turn ${String(turn)} not found.\n`);
      process.exit(1);
    }

    printNode(targetNode, turn, events);
  } finally {
    store.close();
  }
}
