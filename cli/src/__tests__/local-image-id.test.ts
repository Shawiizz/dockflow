import { describe, expect, it, spyOn } from 'bun:test';
import { getLocalImageId } from '../services/distribution';

describe('getLocalImageId', () => {
  it('asks the engine that built the image', async () => {
    const calls: string[][] = [];
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => {
      calls.push(argv);
      return { stdout: new Response('sha256:abc\n').body, stderr: new Response('').body, exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn);
    try {
      expect(await getLocalImageId('web:1', 'podman')).toBe('sha256:abc');
      expect(calls).toEqual([['podman', 'images', '--no-trunc', '-q', 'web:1']]);
    } finally {
      spawn.mockRestore();
    }
  });
});
