import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import * as ssh from '../utils/ssh';
import * as output from '../utils/output';
import { distributeAll, tagByIdCommand } from '../services/distribution';

const ID = 'sha256:0123abcd';
const node = (name: string) => ({ name, connection: { host: `${name}.example`, port: 22, user: 'deploy', privateKey: 'key' } });

/** Per host: the id its `web:2` tag points to, and whether it holds the image of id ID. */
const hosts: Record<string, { tagId: string; holds: boolean }> = {};
const commands: string[] = [];

const spies = [
  spyOn(Bun, 'spawn').mockImplementation((() => ({
    stdout: new Response(`${ID}\n`).body, stderr: new Response('').body, exited: Promise.resolve(0),
  })) as unknown as typeof Bun.spawn),
  spyOn(ssh, 'sshExec').mockImplementation((async (conn: { host: string }, command: string) => {
    commands.push(`${conn.host}: ${command}`);
    const host = hosts[conn.host];
    if (command.includes(' images ')) return { stdout: `${host.tagId}\n`, stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: host.holds ? 0 : 1 };
  }) as never),
  spyOn(ssh, 'sshExecChannel').mockImplementation((async () => { throw new Error('no transfer expected'); }) as never),
  spyOn(output, 'printDim').mockImplementation(() => {}),
  spyOn(output, 'createTimedSpinner').mockImplementation((() => ({ start() {}, update() {}, succeed() {}, fail() {} })) as never),
];
afterAll(() => { for (const spy of spies) spy.mockRestore(); });

describe('distributeAll', () => {
  it('sends nothing to a node that holds the image, under the same tag or another', async () => {
    hosts['same.example'] = { tagId: ID, holds: true };
    hosts['previous.example'] = { tagId: '', holds: true };
    await distributeAll(['web:2'], [node('same'), node('previous')]);

    expect(commands.filter((c) => c.startsWith('same.example')).length).toBe(1);
    expect(commands).toContain(`previous.example: ${tagByIdCommand(ID, 'web:2', 'docker')}`);
  });
});

describe('tagByIdCommand', () => {
  it('tags from the bare id, only when the node holds it', () => {
    expect(tagByIdCommand(ID, 'web:2', 'podman')).toBe("podman image inspect '0123abcd' >/dev/null 2>&1 && podman tag '0123abcd' 'web:2'");
  });
});
