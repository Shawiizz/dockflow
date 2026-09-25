// U-DOCS-05 (design-07 14.3, NEW): the statements the review round requires are present on their
// page, matched by a stable fragment — not the full sentence, so a copy-edit pass does not break this
// file, but specific enough that the claim could not be satisfied by accident. One test per
// (page, fragment) pair names exactly what is missing when a page regresses.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_DIR = resolve(import.meta.dir, '..', '..', '..', '..', '..');
const EN_DIR = join(REPO_DIR, 'docs', 'app', 'en');

interface Claim {
  /** design-07 14.3 U-DOCS-05 clause this covers */
  id: string;
  /** page path relative to docs/app/en */
  page: string;
  fragments: string[];
}

const CLAIMS: Claim[] = [
  {
    id: 'bootstrap-identity (orchestrator page, K59)',
    page: 'configuration/orchestrator/page.mdx',
    fragments: ['Breaking change', 'bootstrap identity'],
  },
  {
    id: 'bootstrap-identity (setup page, K59)',
    page: 'configuration/kubernetes/setup/page.mdx',
    fragments: ['Breaking change', 'bootstrap identity'],
  },
  {
    id: 'per-manager history/audit/metrics (multi-host page, K78)',
    page: 'configuration/multi-host/page.mdx',
    fragments: ['`dockflow history`, `audit` and `metrics`'],
  },
  {
    id: 'per-node backup index (backup page, K78)',
    page: 'configuration/backup/page.mdx',
    fragments: ['the backup index is per node, not in the cluster'],
  },
  {
    id: 'host-plugin interaction (plugins page, K78)',
    page: 'configuration/plugins/page.mdx',
    fragments: ['not orchestrator-level'],
  },
  {
    id: '-y and API routes never delete volumes (volumes page)',
    page: 'configuration/volumes/page.mdx',
    fragments: ['skips **both** the prompt and the typed confirmation', 'the delete path does not exist in the route table'],
  },
  {
    id: 'unchanged accessories deploy leaves a stopped accessory stopped (accessories page)',
    page: 'configuration/accessories/page.mdx',
    fragments: ['stays at 0** across ordinary app deploys'],
  },
  {
    id: 'external Secret config-hash limitation (kubernetes page, K68)',
    page: 'configuration/kubernetes/page.mdx',
    fragments: ['declared `external: true` is not read by Dockflow at all'],
  },
  {
    id: '--dry-run connects, dockflow validate is offline (kubernetes page, K68)',
    page: 'configuration/kubernetes/page.mdx',
    fragments: ['fully offline check', 'does** connect: it resolves a control-plane node'],
  },
  {
    id: 'app-only rollback and its warning (deployment page, K45)',
    page: 'deployment/page.mdx',
    fragments: ['restores the **app** role only', 'accessories are never rolled back automatically'],
  },
  {
    id: 'private hook directory (hooks page, K33 (f))',
    page: 'configuration/hooks/page.mdx',
    fragments: ['private working directory', '(mode `0700`, owned by the deploy user)'],
  },
  {
    id: '"not supported" behaviour (ui page, K69)',
    page: 'ui/page.mdx',
    fragments: ['HTTP 501 with a suggestion', 'the UI never deletes volumes'],
  },
];

describe('U-DOCS-05 docs claims', () => {
  test('every claim names at least one fragment', () => {
    for (const claim of CLAIMS) expect(claim.fragments.length, claim.id).toBeGreaterThan(0);
  });

  for (const claim of CLAIMS) {
    describe(claim.id, () => {
      const text = readFileSync(join(EN_DIR, claim.page), 'utf8');
      for (const fragment of claim.fragments) {
        test(`${claim.page} contains "${fragment}"`, () => {
          expect(text.includes(fragment), `${claim.page} is missing the fragment: ${fragment}`).toBe(true);
        });
      }
    });
  }
});
