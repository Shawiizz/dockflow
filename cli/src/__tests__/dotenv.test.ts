import { describe, expect, it } from 'bun:test';
import { parseDotenv } from '../utils/secrets';

// What the parser already read correctly must keep reading the same way.
describe('parseDotenv — single-line values', () => {
  it('reads plain values and trims around them', () => {
    expect(parseDotenv('A=one\n  B = two  \n')).toEqual({ A: 'one', B: 'two' });
  });

  it('strips matching surrounding quotes', () => {
    expect(parseDotenv('A="one"\nB=\'two\'')).toEqual({ A: 'one', B: 'two' });
  });

  it('keeps inner quotes when the value starts and ends with the same one', () => {
    expect(parseDotenv('P="p"ss"')).toEqual({ P: 'p"ss' });
  });

  it('skips comments, blank lines and lines without =', () => {
    expect(parseDotenv('# note\n\nnot a pair\nA=1')).toEqual({ A: '1' });
  });

  it('keeps everything after the first =', () => {
    expect(parseDotenv('URL=postgres://u:p@h/db?a=1')).toEqual({ URL: 'postgres://u:p@h/db?a=1' });
  });

  it('keeps a lone opening quote as part of the value', () => {
    expect(parseDotenv('A="unclosed')).toEqual({ A: '"unclosed' });
  });

  it('does not expand escape sequences', () => {
    expect(parseDotenv('A="one\\ntwo"')).toEqual({ A: 'one\\ntwo' });
  });
});

describe('parseDotenv — multi-line values', () => {
  const key = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjE=', '-----END OPENSSH PRIVATE KEY-----'];

  it('reads a double-quoted value up to the line closing its quote', () => {
    const content = `A=1\nKEY="${key[0]}\n${key[1]}\n${key[2]}"\nB=2`;

    expect(parseDotenv(content)).toEqual({ A: '1', KEY: key.join('\n'), B: '2' });
  });

  it('reads a single-quoted value the same way', () => {
    expect(parseDotenv(`KEY='${key.join('\n')}'`).KEY).toBe(key.join('\n'));
  });

  it('keeps a trailing newline when the closing quote sits on its own line', () => {
    expect(parseDotenv(`KEY="${key.join('\n')}\n"`).KEY).toBe(`${key.join('\n')}\n`);
  });

  it('a Windows file yields no carriage returns inside the value', () => {
    const content = `KEY="${key.join('\r\n')}"\r\nB=2\r\n`;

    expect(parseDotenv(content)).toEqual({ KEY: key.join('\n'), B: '2' });
  });

  it('a base64 line ending in = inside the value is not mistaken for a new pair', () => {
    const content = `KEY="${key[0]}\nAAAA==\n${key[2]}"\nNEXT=ok`;

    expect(parseDotenv(content)).toEqual({ KEY: `${key[0]}\nAAAA==\n${key[2]}`, NEXT: 'ok' });
  });
});
