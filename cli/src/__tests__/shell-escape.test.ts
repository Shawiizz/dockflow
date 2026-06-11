import { describe, expect, it } from 'bun:test';
import { shellEscape } from '../utils/ssh';

describe('shellEscape', () => {
  it('passes through values without quotes', () => {
    expect(shellEscape('simple-value_123')).toBe('simple-value_123');
  });

  it('escapes single quotes for use inside single-quoted strings', () => {
    expect(shellEscape("it's")).toBe("it'\\''s");
  });

  it('escapes multiple single quotes', () => {
    expect(shellEscape("a'b'c")).toBe("a'\\''b'\\''c");
  });

  it('an injection attempt stays inert inside single quotes', () => {
    const payload = "'; rm -rf / #";
    const escaped = shellEscape(payload);
    // When wrapped in single quotes, the result must re-enter quoting after each escape
    expect(`'${escaped}'`).toBe("''\\''; rm -rf / #'");
  });

  it('leaves double quotes, backticks and dollars untouched (single-quote context)', () => {
    expect(shellEscape('a"b`c$d')).toBe('a"b`c$d');
  });
});
