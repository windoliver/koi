interface VersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(version: string): VersionParts | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (match === null) return null;
  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  if (majorText === undefined || minorText === undefined || patchText === undefined) return null;
  return {
    major: Number(majorText),
    minor: Number(minorText),
    patch: Number(patchText),
  };
}

function compareVersions(left: VersionParts, right: VersionParts): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function checkComparator(version: VersionParts, comparator: string): boolean {
  const trimmed = comparator.trim();
  if (trimmed.length === 0 || trimmed === "*") return true;

  if (trimmed.startsWith("^")) {
    const target = parseVersion(trimmed.slice(1));
    if (target === null) return false;
    const upper =
      target.major > 0
        ? { major: target.major + 1, minor: 0, patch: 0 }
        : target.minor > 0
          ? { major: 0, minor: target.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: target.patch + 1 };
    return compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0;
  }

  if (trimmed.startsWith("~")) {
    const target = parseVersion(trimmed.slice(1));
    if (target === null) return false;
    const upper = { major: target.major, minor: target.minor + 1, patch: 0 };
    return compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0;
  }

  const match = trimmed.match(/^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)/);
  if (match === null) return false;
  const op = match[1] ?? "=";
  const targetText = match[2];
  if (targetText === undefined) return false;
  const target = parseVersion(targetText);
  if (target === null) return false;
  const comparison = compareVersions(version, target);

  if (op === ">=") return comparison >= 0;
  if (op === "<=") return comparison <= 0;
  if (op === ">") return comparison > 0;
  if (op === "<") return comparison < 0;
  return comparison === 0;
}

export function isKoiVersionCompatible(
  range: string | undefined,
  koiVersion: string | undefined,
): boolean {
  if (range === undefined || range.trim().length === 0) return true;
  if (koiVersion === undefined) return true;
  const version = parseVersion(koiVersion);
  if (version === null) return false;

  return range
    .split(/\s+/)
    .filter((part) => part.trim().length > 0)
    .every((part) => checkComparator(version, part));
}
