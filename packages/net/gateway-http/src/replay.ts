export function isWithinReplayWindow(
  nowSec: number,
  requestSec: number,
  windowSec: number,
): boolean {
  if (!Number.isFinite(requestSec)) return false;
  return Math.abs(nowSec - requestSec) <= windowSec;
}
