/**
 * Secret masking for kubectl/helm stderr, events, pod messages, failure messages and debug
 * excerpts. Kubernetes echoes Secret data base64-encoded and URLs carry credentials URL-encoded,
 * so each value is masked in all three forms.
 */

const MASK = '***';
/** shorter values would mask ordinary words and numbers everywhere */
const MIN_LENGTH = 6;

export class Redactor {
  private readonly forms = new Set<string>();

  /** values shorter than 6 characters are ignored */
  constructor(values?: Iterable<string>) {
    if (values) this.add(values);
  }

  add(values: Iterable<string>): void {
    for (const value of values) {
      if (value.length < MIN_LENGTH) continue;
      const base64 = Buffer.from(value, 'utf8').toString('base64');
      this.forms.add(value);
      this.forms.add(base64);
      // padding is dropped wherever base64 is embedded in a longer token
      this.forms.add(base64.replace(/=+$/, ''));
      this.forms.add(encodeURIComponent(value));
    }
  }

  /** replaces each value, its base64 form and its URL-encoded form with *** */
  redact(text: string): string {
    if (this.forms.size === 0 || text.length === 0) return text;

    const spans: [number, number][] = [];
    for (const form of this.forms) {
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        spans.push([at, at + form.length]);
      }
    }
    if (spans.length === 0) return text;

    // Overlapping matches are merged into one mask: replacing values one by one, even longest
    // first, leaves the tail of a value that overlaps another one visible.
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged: [number, number][] = [];
    for (const [start, stop] of spans) {
      const last = merged.at(-1);
      if (last && start < last[1]) last[1] = Math.max(last[1], stop);
      else merged.push([start, stop]);
    }

    let out = '';
    let cursor = 0;
    for (const [start, stop] of merged) {
      out += text.slice(cursor, start) + MASK;
      cursor = stop;
    }
    return out + text.slice(cursor);
  }
}
