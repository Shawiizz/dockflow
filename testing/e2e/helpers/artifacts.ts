/**
 * Where a run leaves what a failed CI job uploads, and the scrubbing everything written there goes
 * through: fixture secrets are named `E2E_SECRET_<PURPOSE>_<suffix>` so they can be found and masked.
 */

import { join } from "path";

export const ARTIFACTS_DIR = process.env.DOCKFLOW_E2E_ARTIFACTS || join(import.meta.dir, "..", ".artifacts");

const SECRET_RE = /E2E_SECRET_[A-Za-z0-9_]*/g;

export function scrub(text: string): string {
  return text.replace(SECRET_RE, "***");
}
