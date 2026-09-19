// FakeLocalEngine (design-07 3.7): the local docker calls of services/distribution.ts that an image
// import makes (tag, image id, save). `save` streams a deterministic payload, a fixed 512-byte header
// followed by the saved references, so a gunzipped stdin assertion is byte-exact; `fail()` makes the
// next call of a method fail the way the real engine does.

import { Readable } from 'stream';
import { type ContainerRuntime, type LocalEngine, localEngineError } from '../../../services/distribution';

export const FAKE_SAVE_HEADER_BYTES = 512;
const FAKE_SAVE_MAGIC = 'dockflow fake image archive';

export type LocalEngineMethod = 'tag' | 'imageId' | 'save';

export interface LocalEngineCall {
  method: LocalEngineMethod;
  args: string[];
}

/** The exact bytes `save(refs)` streams. */
export function fakeSavePayload(refs: readonly string[]): Uint8Array {
  const header = Buffer.alloc(FAKE_SAVE_HEADER_BYTES);
  header.write(FAKE_SAVE_MAGIC, 0, 'utf8');
  const list = Buffer.from(refs.map((ref) => `${ref}\n`).join(''), 'utf8');
  return new Uint8Array(Buffer.concat([header, list]));
}

/** The references a fake payload carries; null for anything else. */
export function refsOfFakePayload(bytes: Uint8Array): string[] | null {
  const buffer = Buffer.from(bytes);
  if (buffer.length < FAKE_SAVE_HEADER_BYTES) return null;
  if (buffer.subarray(0, FAKE_SAVE_MAGIC.length).toString('utf8') !== FAKE_SAVE_MAGIC) return null;
  return buffer
    .subarray(FAKE_SAVE_HEADER_BYTES)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/** A 64-hex image id derived from a seed, for readable fixtures. */
export function fakeImageId(seed: string): string {
  const hex = Buffer.from(seed, 'utf8').toString('hex');
  return `sha256:${hex.padEnd(64, '0').slice(0, 64)}`;
}

export class FakeLocalEngine implements LocalEngine {
  readonly kind: ContainerRuntime;
  readonly calls: LocalEngineCall[] = [];
  private readonly ids = new Map<string, string>();
  private readonly failures = new Map<LocalEngineMethod, string[]>();

  /** `images`: local reference -> image id */
  constructor(images: Record<string, string> = {}, options: { kind?: ContainerRuntime } = {}) {
    this.kind = options.kind ?? 'docker';
    for (const [ref, id] of Object.entries(images)) this.ids.set(ref, id);
  }

  /** the id a local reference has now (tags included), null when it does not exist */
  idOf(ref: string): string | null {
    return this.ids.get(ref) ?? null;
  }

  /** every `save` call, in order */
  get saves(): string[][] {
    return this.calls.filter((call) => call.method === 'save').map((call) => call.args);
  }

  /** the next call of `method` fails with `stderr` */
  fail(method: LocalEngineMethod, stderr: string): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), stderr]);
  }

  async tag(source: string, target: string): Promise<void> {
    const args = ['tag', source, target];
    this.calls.push({ method: 'tag', args });
    this.injected('tag', args);
    const id = this.ids.get(source);
    if (id === undefined) throw localEngineError(this.kind, args, `Error response from daemon: No such image: ${source}`);
    this.ids.set(target, id);
  }

  async imageId(ref: string): Promise<string> {
    const args = ['image', 'inspect', '--format', '{{.Id}}', ref];
    this.calls.push({ method: 'imageId', args: [ref] });
    this.injected('imageId', args);
    const id = this.ids.get(ref);
    if (id === undefined) throw localEngineError(this.kind, args, `Error: No such image: ${ref}`);
    return id;
  }

  save(refs: readonly string[]): Readable {
    const args = ['save', ...refs];
    this.calls.push({ method: 'save', args: [...refs] });
    const stderr = this.failures.get('save')?.shift();
    const missing = refs.find((ref) => !this.ids.has(ref));
    if (stderr !== undefined || missing !== undefined) {
      const error = localEngineError(this.kind, args, stderr ?? `Error response from daemon: reference does not exist: ${missing}`);
      return new Readable({
        read() {
          this.destroy(error);
        },
      });
    }
    return Readable.from([Buffer.from(fakeSavePayload(refs))]);
  }

  private injected(method: LocalEngineMethod, args: readonly string[]): void {
    const stderr = this.failures.get(method)?.shift();
    if (stderr !== undefined) throw localEngineError(this.kind, args, stderr);
  }
}
