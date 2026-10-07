import { afterEach, describe, expect, it } from 'bun:test';
import { dispatchInterrupt, onInterrupt } from '../utils/interrupt';

const exits: number[] = [];
const exit = (code: number): void => {
  exits.push(code);
};

afterEach(() => {
  // a test that registered and never dispatched must not leave its handler to the next one
  dispatchInterrupt(0, () => {});
  exits.length = 0;
});

describe('dispatchInterrupt', () => {
  it('exits with the signal code when no command registered a cleanup', () => {
    dispatchInterrupt(130, exit);
    expect(exits).toEqual([130]);
  });

  it('runs the registered handlers instead of exiting, once: a second signal exits at once', () => {
    const ran: string[] = [];
    onInterrupt(() => ran.push('a'));
    onInterrupt(() => ran.push('b'));

    dispatchInterrupt(130, exit);
    expect(ran).toEqual(['a', 'b']);
    expect(exits).toEqual([]);

    dispatchInterrupt(130, exit);
    expect(ran).toEqual(['a', 'b']);
    expect(exits).toEqual([130]);
  });

  it('an unregistered handler no longer runs', () => {
    const ran: string[] = [];
    const stop = onInterrupt(() => ran.push('a'));
    stop();

    dispatchInterrupt(143, exit);
    expect(ran).toEqual([]);
    expect(exits).toEqual([143]);
  });
});
