// design-07 8.3 P-R01: secret values never survive redaction in any of the forms Kubernetes and
// URLs echo them in.

import { describe, expect } from 'bun:test';
import { Redactor } from '../../../utils/redact';
import { pick, randomInt, type Rng } from '../support/prng';
import { forAll } from '../support/property';

// no `*`: the mask itself must not be able to spell a value
const SECRET_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~!$&()+,;=:@/? %#"\'\u{e9}\u{65e5}\u{1f511}';
const FILLER_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789 \n:/=+-_."{}[]';

function text(rng: Rng, alphabet: string, min: number, max: number): string {
  const chars = [...alphabet];
  let out = '';
  for (let i = randomInt(rng, min, max); i > 0; i--) out += pick(rng, chars);
  return out;
}

function forms(value: string): string[] {
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  return [value, base64, base64.replace(/=+$/, ''), encodeURIComponent(value)];
}

function embed(rng: Rng, pieces: string[]): string {
  let out = text(rng, FILLER_CHARS, 0, 30);
  for (const piece of pieces) out += piece + text(rng, FILLER_CHARS, 0, 30);
  return out;
}

describe('redaction (design-07 8.3)', () => {
  forAll(
    'P-R01 values of 6+ characters never survive, in plain, base64 or URL-encoded form',
    (rng, size) => {
      const values = Array.from({ length: randomInt(rng, 1, 4) }, () => text(rng, SECRET_CHARS, 6, 6 + size));
      const pieces = values.flatMap((value) => {
        const [plain, base64, unpadded, url] = forms(value);
        return [pick(rng, [plain, base64, unpadded, url]), pick(rng, [plain, url])];
      });
      return { values, input: embed(rng, pieces) };
    },
    ({ values, input }) => {
      const output = new Redactor(values).redact(input);
      for (const value of values) {
        for (const form of forms(value)) expect(output.includes(form)).toBe(false);
      }
    },
  );

  forAll(
    'P-R01 values shorter than 6 characters leave the text untouched',
    (rng) => {
      // length counts UTF-16 code units, as String.length does: an emoji is two
      const values = Array.from({ length: randomInt(rng, 1, 4) }, () => {
        let value = text(rng, SECRET_CHARS, 1, 5);
        while (value.length > 5) value = [...value].slice(0, -1).join('');
        return value;
      });
      return { values, input: embed(rng, values) };
    },
    ({ values, input }) => {
      expect(new Redactor(values).redact(input)).toBe(input);
    },
  );

  forAll(
    'P-R01 overlapping values are both masked',
    (rng) => {
      const overlap = text(rng, SECRET_CHARS, 1, 5);
      const first = text(rng, SECRET_CHARS, 6, 12) + overlap;
      const second = overlap + text(rng, SECRET_CHARS, 6, 12);
      const joined = first + second.slice(overlap.length);
      return { values: rng() < 0.5 ? [first, second] : [second, first], input: embed(rng, [joined]) };
    },
    ({ values, input }) => {
      const output = new Redactor(values).redact(input);
      for (const value of values) expect(output.includes(value)).toBe(false);
    },
  );

  forAll(
    'P-R01 values added later with add() are masked too',
    (rng) => {
      const early = text(rng, SECRET_CHARS, 6, 20);
      const late = text(rng, SECRET_CHARS, 6, 20);
      return { early, late, input: embed(rng, [early, late]) };
    },
    ({ early, late, input }) => {
      const redactor = new Redactor([early]);
      redactor.add([late]);
      const output = redactor.redact(input);
      expect(output.includes(early)).toBe(false);
      expect(output.includes(late)).toBe(false);
    },
  );
});
