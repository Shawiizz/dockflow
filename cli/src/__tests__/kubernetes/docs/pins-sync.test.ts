// U-DOCS-02 (design-07 14.3): the k3s-pins region of the cluster setup guide matches the pinned
// versions cli/scripts/pin-kubernetes.ts (P03) generates. pin-kubernetes.ts fetches and hashes
// releases over the network, so this file does not invoke it; it re-renders the same fixed table
// shape (design-07 19.3) from the committed pin constants and compares it against the doc region.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HELM_PIN, TRAEFIK_CHART_PIN } from '../../../services/orchestrator/kubernetes/versions';
import { K3S_PIN } from '../../../services/orchestrator/kubernetes/k3s/versions';

const REPO_DIR = resolve(import.meta.dir, '..', '..', '..', '..', '..');
const SETUP_PAGE = join(REPO_DIR, 'docs', 'app', 'en', 'configuration', 'kubernetes', 'setup', 'page.mdx');

const REGENERATE_HINT = 'Run: bun run scripts/pin-kubernetes.ts --k3s <version> --helm <version> --traefik-chart <version>';

// Markers and format owned by cli/scripts/pin-kubernetes.ts (`DOCS_BEGIN`/`DOCS_END`,
// `renderDocsRegion`); kept in sync here because that script exports nothing (it runs only from a
// machine with network access, never from a unit test).
const PINS_BEGIN = '{/* BEGIN GENERATED: k3s-pins (cli/scripts/pin-kubernetes.ts) */}';
const PINS_END = '{/* END GENERATED: k3s-pins */}';

function renderPinsRegion(): string {
  return [
    PINS_BEGIN,
    '| Component | Version |',
    '|---|---|',
    `| k3s | \`${K3S_PIN.version}\` |`,
    `| Minimum server version | \`${K3S_PIN.minimumServerVersion}\` |`,
    `| Helm | \`${HELM_PIN.version}\` |`,
    `| Traefik chart | \`${TRAEFIK_CHART_PIN.version}\` (Traefik \`${TRAEFIK_CHART_PIN.appVersion}\`) |`,
    PINS_END,
  ].join('\n');
}

/** The exact marker-to-marker block, or null when the page has no single complete pair. */
function extractPinsRegion(page: string): string | null {
  const text = page.replace(/\r\n/g, '\n');
  const start = text.indexOf(PINS_BEGIN);
  if (start < 0 || text.indexOf(PINS_BEGIN, start + PINS_BEGIN.length) >= 0) return null;
  const end = text.indexOf(PINS_END, start + PINS_BEGIN.length);
  if (end < 0 || text.indexOf(PINS_END, end + PINS_END.length) >= 0) return null;
  return text.slice(start, end + PINS_END.length);
}

describe('U-DOCS-02 k3s pins doc sync', () => {
  const page = readFileSync(SETUP_PAGE, 'utf8');

  test('the setup guide has exactly one k3s-pins region', () => {
    expect(extractPinsRegion(page), `${SETUP_PAGE} has no ${PINS_BEGIN} ... ${PINS_END} region. ${REGENERATE_HINT}`).not.toBeNull();
  });

  test('the committed k3s-pins region equals the rendered pin table', () => {
    const region = extractPinsRegion(page);
    expect(region, `The k3s-pins region is stale. ${REGENERATE_HINT}`).toBe(renderPinsRegion());
  });

  test('every pinned version cited by the table is the one the page displays', () => {
    const region = extractPinsRegion(page) ?? '';
    expect(region).toContain(`\`${K3S_PIN.version}\``);
    expect(region).toContain(`\`${K3S_PIN.minimumServerVersion}\``);
    expect(region).toContain(`\`${HELM_PIN.version}\``);
    expect(region).toContain(`\`${TRAEFIK_CHART_PIN.version}\``);
    expect(region).toContain(`\`${TRAEFIK_CHART_PIN.appVersion}\``);
  });
});
