// Just enough semver for template versions: x.y.z with optional pre-release/build.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseSemver(version: string): SemVer | null {
  const m = SEMVER.exec(version);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

export function isSemver(version: string): boolean {
  return SEMVER.test(version);
}

/** Negative if a < b, 0 if equal, positive if a > b. A pre-release sorts before its release. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`not semver: ${!x ? a : b}`);
  const diff = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  if (diff !== 0) return diff;
  if (x.prerelease === y.prerelease) return 0;
  if (x.prerelease === null) return 1;
  if (y.prerelease === null) return -1;
  return x.prerelease < y.prerelease ? -1 : 1;
}
