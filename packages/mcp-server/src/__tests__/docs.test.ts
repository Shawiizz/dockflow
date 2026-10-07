import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSections } from '../docs.js';

describe('parseSections', () => {
  it('splits the full documentation on its separators and slugs each title', () => {
    const sections = parseSections('# Getting Started\n\nInstall it.\n\n---\n\n# Docker Compose (v2)\n\nWrite it.\n');
    assert.deepEqual(sections.map((s) => [s.title, s.path]), [
      ['Getting Started', 'getting-started'],
      ['Docker Compose (v2)', 'docker-compose-v2'],
    ]);
    assert.ok(sections[0].content.includes('Install it.'));
  });

  it('skips parts without a heading and empty parts', () => {
    assert.deepEqual(parseSections('intro without a heading\n---\n\n---\n# Hooks\n'), [
      { title: 'Hooks', path: 'hooks', content: '# Hooks' },
    ]);
  });
});
