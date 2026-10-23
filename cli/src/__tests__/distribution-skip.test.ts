import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import * as ssh from '../utils/ssh';
import * as output from '../utils/output';
import { distributeAll, tagSameContentCommand } from '../services/distribution';

const node = (name: string) => ({ name, connection: { host: `${name}.example`, port: 22, user: 'deploy', privateKey: 'key' } });

/** Per host: whether it holds an image of the same content, which the tag command then finds. */
const holds: Record<string, boolean> = {};
const commands: string[] = [];
let transfers = 0;

const spies = [
  spyOn(Bun, 'spawn').mockImplementation((() => ({
    stdout: new Response('["sha256:aaa"] ["nginx"]\n').body, stderr: new Response('').body, exited: Promise.resolve(0),
  })) as unknown as typeof Bun.spawn),
  spyOn(ssh, 'sshExec').mockImplementation((async (conn: { host: string }, command: string) => {
    commands.push(`${conn.host}: ${command}`);
    return { stdout: '', stderr: '', exitCode: holds[conn.host] ? 0 : 1 };
  }) as never),
  spyOn(ssh, 'sshExecChannel').mockImplementation((async () => {
    transfers++;
    throw new Error('transfer');
  }) as never),
  spyOn(output, 'printDim').mockImplementation(() => {}),
  spyOn(output, 'printWarning').mockImplementation(() => {}),
  spyOn(output, 'createTimedSpinner').mockImplementation((() => ({ start() {}, update() {}, succeed() {}, fail() {} })) as never),
];
afterAll(() => { for (const spy of spies) spy.mockRestore(); });

describe('distributeAll', () => {
  it('sends nothing to a node that holds an image of the same content, under any tag', async () => {
    holds['current.example'] = true;
    holds['previous.example'] = true;
    await distributeAll(['web:2'], [node('current'), node('previous')]);
    expect(transfers).toBe(0);
    expect(commands.every((c) => c.includes("tag \"$id\" 'web:2'"))).toBe(true);
  });

  it('sends the image to a node that holds none', async () => {
    holds['new.example'] = false;
    await expect(distributeAll(['web:2'], [node('new')])).rejects.toThrow('Failed to transfer web:2');
    expect(transfers).toBeGreaterThan(0);
  });
});

describe('tagSameContentCommand', () => {
  it('looks among the images of the same repository and tags the first of the same content', () => {
    const command = tagSameContentCommand('registry.example:5000/web:2', 'abc', 'docker');
    expect(command).toContain("docker images -q --no-trunc 'registry.example:5000/web'");
    expect(command).toContain("= 'abc' ] && exec docker tag \"$id\" 'registry.example:5000/web:2'");
    expect(command.endsWith('done; exit 1')).toBe(true);
  });
});
