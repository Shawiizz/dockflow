/**
 * The next version after `version`. Examples:
 *   1.0.0 -> 1.0.1
 *   1.0.0-beta -> 1.0.0-beta2
 *   1.0.0-beta2 -> 1.0.0-beta3
 *   main-abc123 -> main-abc123-2
 */
export function incrementVersion(version: string): string {
  // a branch-sha version (main-abc12345) gets a -2 counter; checked first so the suffix rule
  // below does not bump the digits of a hex sha
  if (/^.+-[0-9a-f]{6,}$/i.test(version)) {
    return `${version}-2`;
  }

  const suffixMatch = version.match(/^(.+[a-zA-Z])(\d+)$/);
  if (suffixMatch) {
    const [, base, num] = suffixMatch;
    return `${base}${parseInt(num) + 1}`;
  }

  const semverMatch = version.match(/^(.+)\.(\d+)$/);
  if (semverMatch) {
    const [, base, num] = semverMatch;
    return `${base}.${parseInt(num) + 1}`;
  }

  const dashNumMatch = version.match(/^(.+)-(\d+)$/);
  if (dashNumMatch) {
    const [, base, num] = dashNumMatch;
    return `${base}-${parseInt(num) + 1}`;
  }

  if (/[a-zA-Z]$/.test(version) && /-[a-zA-Z]/.test(version)) {
    return `${version}2`;
  }

  return `${version}-2`;
}

