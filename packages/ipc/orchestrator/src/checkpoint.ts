/**
 * Board serialization — TaskBoard ↔ TaskBoardSnapshot.
 */

import type { TaskBoard, TaskBoardConfig, TaskBoardSnapshot } from "@koi/core";
import { createTaskBoard } from "./board.js";

/**
 * Extracts a serializable snapshot from a TaskBoard.
 */
export function serializeBoard(board: TaskBoard): TaskBoardSnapshot {
  return {
    items: board.all(),
    results: board.completed(),
  };
}

/**
 * Recreates a TaskBoard from a snapshot.
 */
export function deserializeBoard(snapshot: TaskBoardSnapshot, config?: TaskBoardConfig): TaskBoard {
  return createTaskBoard(config, snapshot);
}
