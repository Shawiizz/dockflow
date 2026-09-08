import { describe, expect, it } from 'bun:test';
import { escapeSingleQuotes, shellQuote } from '../utils/ssh';

describe('escapeSingleQuotes', () => {
  it('passes through values without quotes', () => {
    expect(escapeSingleQuotes('simple-value_123')).toBe('simple-value_123');
  });

  it('escapes single quotes for use inside single-quoted strings', () => {
    expect(escapeSingleQuotes("it's")).toBe("it'\\''s");
  });

  it('escapes multiple single quotes', () => {
    expect(escapeSingleQuotes("a'b'c")).toBe("a'\\''b'\\''c");
  });

  it('an injection attempt stays inert inside single quotes', () => {
    const payload = "'; rm -rf / #";
    const escaped = escapeSingleQuotes(payload);
    // When wrapped in single quotes, the result must re-enter quoting after each escape
    expect(`'${escaped}'`).toBe("''\\''; rm -rf / #'");
  });

  it('leaves double quotes, backticks and dollars untouched (single-quote context)', () => {
    expect(escapeSingleQuotes('a"b`c$d')).toBe('a"b`c$d');
  });
});

describe('shellQuote', () => {
  it('wraps the value so it stays one argument', () => {
    expect(shellQuote('simple')).toBe("'simple'");
  });

  it('keeps shell operators inert', () => {
    expect(shellQuote('nginx -t && nginx -s reload')).toBe("'nginx -t && nginx -s reload'");
  });

  it('survives a value containing single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('neutralises an injection attempt', () => {
    expect(shellQuote("'; rm -rf / #")).toBe("''\\''; rm -rf / #'");
  });

  it('a path with spaces stays one token', () => {
    expect(shellQuote('/etc/my app/conf')).toBe("'/etc/my app/conf'");
  });
});
