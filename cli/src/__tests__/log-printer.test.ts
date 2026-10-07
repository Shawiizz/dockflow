import { describe, expect, it } from 'bun:test';
import { createLogPrinter } from '../commands/app/logs';

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

function printed(options: { prefix: boolean; services: number }, lines: [string, string, number][]): string[] {
  const out: string[] = [];
  const print = createLogPrinter(options, (text) => out.push(strip(text)));
  for (const [line, instance, instances] of lines) print(line, { instance, instances });
  return out;
}

describe('createLogPrinter', () => {
  it('prints a lone instance as it is', () => {
    expect(printed({ prefix: true, services: 1 }, [['GET / 200', 'web', 1]])).toEqual(['GET / 200']);
  });

  it('prefixes each line with its instance once several share the output', () => {
    expect(printed({ prefix: true, services: 1 }, [['a', 'web.1', 2], ['b', 'web.2', 2]])).toEqual(['web.1 | a', 'web.2 | b']);
    expect(printed({ prefix: true, services: 2 }, [['a', 'web', 1], ['b', 'worker', 1]])).toEqual(['web | a', 'worker | b']);
  });

  it('--no-prefix prints lines as they are', () => {
    expect(printed({ prefix: false, services: 2 }, [['a', 'web.1', 2]])).toEqual(['a']);
  });
});
