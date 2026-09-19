// Reference implementation of the kubelet's `$(VAR)` expansion (third_party/forked/golang/expansion
// at Kubernetes v1.34.0), used to prove that escaped commands, args and exec probes arrive
// verbatim (design-02 T4): `$$` becomes `$`, `$(NAME)` becomes the value of NAME or stays literal
// when NAME is undefined, an unterminated `$(` and any other `$x` stay as written.

export type ExpansionEnv = Readonly<Record<string, string>>;

function expandOne(input: string, env: ExpansionEnv): string {
  let out = '';
  let checkpoint = 0;
  for (let cursor = 0; cursor < input.length; cursor++) {
    if (input[cursor] !== '$' || cursor + 1 >= input.length) continue;
    out += input.slice(checkpoint, cursor);
    const next = input[cursor + 1];
    if (next === '$') {
      out += '$';
      cursor += 1;
    } else if (next === '(') {
      const close = input.indexOf(')', cursor + 2);
      if (close === -1) {
        // Incomplete reference: the operator and the opener are copied, scanning resumes after them.
        out += '$(';
        cursor += 1;
      } else {
        const name = input.slice(cursor + 2, close);
        out += Object.hasOwn(env, name) ? env[name] : `$(${name})`;
        cursor = close;
      }
    } else {
      out += `$${next}`;
      cursor += 1;
    }
    checkpoint = cursor + 1;
  }
  return out + input.slice(checkpoint);
}

/** What the kubelet runs for `input` when the container environment is `env`. */
export function k8sExpand(input: string, env?: ExpansionEnv): string;
export function k8sExpand(input: readonly string[], env?: ExpansionEnv): string[];
export function k8sExpand(input: string | readonly string[], env: ExpansionEnv = {}): string | string[] {
  return typeof input === 'string' ? expandOne(input, env) : input.map((value) => expandOne(value, env));
}
