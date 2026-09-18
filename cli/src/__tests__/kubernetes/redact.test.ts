import { describe, expect, it } from 'bun:test';
import { Redactor } from '../../utils/redact';

const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

describe('Redactor (U-REDACT-01)', () => {
  it('ignores values shorter than 6 characters', () => {
    const redactor = new Redactor(['abc12', '', 'admin']);
    expect(redactor.redact('user admin with pin abc12')).toBe('user admin with pin abc12');
  });

  it('masks a value of exactly 6 characters', () => {
    expect(new Redactor(['s3cr3t']).redact('token=s3cr3t;')).toBe('token=***;');
  });

  it('masks the plain form at every occurrence', () => {
    const redactor = new Redactor(['hunter2-password']);
    expect(redactor.redact('a hunter2-password b hunter2-password')).toBe('a *** b ***');
  });

  it('masks the base64 form, as Kubernetes prints Secret data', () => {
    const value = 'db-password-42';
    const redactor = new Redactor([value]);
    expect(redactor.redact(`data:\n  PASSWORD: ${base64(value)}\n`)).toBe('data:\n  PASSWORD: ***\n');
  });

  it('masks the base64 form without its padding', () => {
    const value = 'db-password-4';
    expect(base64(value).endsWith('=')).toBe(true);
    const unpadded = base64(value).replace(/=+$/, '');
    expect(new Redactor([value]).redact(`token.${unpadded}.sig`)).toBe('token.***.sig');
  });

  it('masks the URL-encoded form', () => {
    const value = 'p@ss w/rd:1';
    const redactor = new Redactor([value]);
    expect(redactor.redact(`https://user:${encodeURIComponent(value)}@registry.example.com`)).toBe(
      'https://user:***@registry.example.com',
    );
    expect(redactor.redact(`plain ${value}`)).toBe('plain ***');
  });

  it('masks values added later with add()', () => {
    const redactor = new Redactor();
    expect(redactor.redact('late-secret-value')).toBe('late-secret-value');
    redactor.add(['late-secret-value']);
    expect(redactor.redact('x late-secret-value y')).toBe('x *** y');
    redactor.add(new Set(['another-secret']));
    expect(redactor.redact('another-secret late-secret-value')).toBe('*** ***');
  });

  it('masks the longest value when one contains another', () => {
    const redactor = new Redactor(['supersecret', 'supersecret-extended']);
    expect(redactor.redact('x supersecret-extended y')).toBe('x *** y');
    expect(redactor.redact('x supersecret y')).toBe('x *** y');
  });

  it('leaves no fragment of two values that overlap', () => {
    const redactor = new Redactor(['abcdef12', '12345678']);
    expect(redactor.redact('>abcdef12345678<')).toBe('>***<');
  });

  it('returns text without values unchanged', () => {
    expect(new Redactor(['nothing-matches']).redact('plain text')).toBe('plain text');
    expect(new Redactor(['nothing-matches']).redact('')).toBe('');
  });
});
