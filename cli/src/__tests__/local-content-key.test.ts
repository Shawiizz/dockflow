import { describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { getLocalContentKey, IMAGE_CONTENT_FORMAT } from '../services/distribution';

const spawnReturning = (stdout: string, exitCode = 0) => (argv: string[], calls: string[][]) => {
  calls.push(argv);
  return { stdout: new Response(stdout).body, stderr: new Response('').body, exited: Promise.resolve(exitCode) };
};

describe('getLocalContentKey', () => {
  it('asks the engine that built the image and hashes what it prints, as sha256sum does', async () => {
    const calls: string[][] = [];
    const printed = '["sha256:aaa"] ["PATH=/bin"] ["nginx"]\n';
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => spawnReturning(printed)(argv, calls)) as unknown as typeof Bun.spawn);
    try {
      expect(await getLocalContentKey('web:1', 'podman')).toBe(createHash('sha256').update(printed).digest('hex'));
      expect(calls).toEqual([['podman', 'image', 'inspect', '--format', IMAGE_CONTENT_FORMAT, 'web:1']]);
    } finally {
      spawn.mockRestore();
    }
  });

  it('is empty for an image the engine does not know', async () => {
    const calls: string[][] = [];
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => spawnReturning('', 1)(argv, calls)) as unknown as typeof Bun.spawn);
    try {
      expect(await getLocalContentKey('web:1')).toBe('');
    } finally {
      spawn.mockRestore();
    }
  });
});
