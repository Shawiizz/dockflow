import { describe, expect, it } from 'bun:test';
import { pickActiveManager } from '../utils/servers/failover';
import { chooseServer } from '../utils/validation';

const servers = [
  { name: 'worker-1', role: 'worker' },
  { name: 'manager-1', role: 'manager' },
  { name: 'manager-2', role: 'manager' },
];
const everyone = () => true;

describe('chooseServer', () => {
  it('picks the first manager, never a worker listed first', () => {
    expect(chooseServer('production', servers, undefined, {}, everyone)).toEqual({ name: 'manager-1' });
  });

  it('skips a manager this machine has no credentials for', () => {
    expect(chooseServer('production', servers, undefined, {}, (name) => name === 'manager-2')).toEqual({ name: 'manager-2' });
  });

  it('refuses a worker named for a command that runs on a manager, and lists the managers', () => {
    expect(chooseServer('production', servers, 'worker-1', {}, everyone)).toMatchObject({
      message: 'Server "worker-1" is a worker; this command runs on a manager',
      suggestion: 'Managers: manager-1, manager-2',
    });
  });

  it('refuses an unknown server', () => {
    expect(chooseServer('production', servers, 'nope', {}, everyone)).toMatchObject({
      message: 'No server named "nope" for environment production',
    });
  });

  it('accepts any server when the command allows it', () => {
    expect(chooseServer('production', servers, 'worker-1', { anyServer: true }, everyone)).toEqual({ name: 'worker-1' });
  });

  it('reports an environment without a manager', () => {
    expect(chooseServer('production', [servers[0]], undefined, {}, everyone)).toMatchObject({
      message: 'No manager for environment production',
    });
  });
});

describe('pickActiveManager', () => {
  it('prefers the leader wherever it is listed', () => {
    const probes = [
      { manager: 'a', status: 'reachable' as const },
      { manager: 'b', status: 'leader' as const },
    ];
    expect(pickActiveManager(probes)).toEqual({ manager: 'b', status: 'leader' });
    expect(pickActiveManager(probes, false)).toEqual({ manager: 'a', status: 'reachable' });
  });

  it('never picks a node that cannot take Swarm commands, nor one it cannot reach', () => {
    expect(
      pickActiveManager([
        { manager: 'a', status: 'unready' },
        { manager: 'b', status: 'unreachable' },
        { manager: 'c', status: 'no-key' },
        { manager: 'd', status: 'reachable' },
      ]),
    ).toEqual({ manager: 'd', status: 'reachable' });
    expect(pickActiveManager([{ manager: 'a', status: 'unready' }])).toBeNull();
  });
});
