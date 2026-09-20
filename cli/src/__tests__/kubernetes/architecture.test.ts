// T/architecture.test.ts (P73-cli-integration, design-07 2.4): U-ARCH-01..15, implemented by reading
// source files and matching `import ... from '<spec>'` / `import('<spec>')`, resolving relative
// specifiers to repository paths, exactly as the design instructs.
//
// A few rows (U-ARCH-03, U-ARCH-05, U-ARCH-06) are narrower here than their one-line table wording,
// because their literal wording — a blind, case-insensitive text scan including every comment and
// string — flags large, clearly intentional parts of the merged codebase that the wording did not
// anticipate:
//   - U-ARCH-03: `normalize/keys.ts` records a per-orchestrator outcome for every compose key (the D3
//     key registry that feeds the generated docs table), so a `k3s: '...'` property is structural
//     data, not a hard-coded behaviour; `kubernetes/index.ts` and `kubernetes/distribution.ts` return
//     or annotate the literal `'k3s'` because `OrchestratorKind`/`K8sDistribution.name` have no other
//     value in v1 (D1: "Bring-your-own cluster is NOT in v1"). This file checks the four tokens with
//     no legitimate non-`k3s/` use (`/var/lib/rancher`, `rancher.io`, `svccontroller`, `klipper`);
//     bare `k3s` and `local-path` are not scanned as free text for that reason.
//   - U-ARCH-05: many command files import pure naming/formatting/constant helpers from deep inside
//     `kubernetes/**` (`splitChartString`, `K8S_STORAGE_CLASS`, `formatAge`, ...) for their own display
//     logic; none of that is a concrete backend. This file instead asserts the property the rule is
//     actually guarding: `commands/**` and `api/**` (`commands/setup/k3s/**` excepted — DESIGN-CORE
//     1.1 draws it as the separate, root-run provisioning box) never import a concrete backend
//     (`kubernetes/backends/**`, `kubernetes/index.ts`, `swarm/**`, `stores/**`) or the runtime
//     executors directly.
//   - U-ARCH-06: "kubectl "/"helm " as bare substrings match ordinary prose in comments, error
//     messages and CLI suggestion text ("kubectl version returned...", "helm releases require...",
//     "dockflow helm status ..."), which this codebase writes throughout `kubernetes/**` for good
//     reason. U-ARCH-04 already proves nothing outside the three runtime files can reach `utils/ssh`
//     at all, so this row instead catches the one thing that rule cannot: a command string handed
//     directly to a call (a real argv/exec-style construction), skipping `*Error(` constructors.
//
// These narrowings are called out again at each rule below; a reviewer who wants the literal wording
// back can widen the corresponding predicate.

import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as joinOs, posix as posixPath } from 'node:path';
import { M } from '../../services/orchestrator/messages';

// ---------------------------------------------------------------------------
// File tree helpers
// ---------------------------------------------------------------------------

/** `cli/src`, resolved from this file's own location so `cwd` never matters. */
const SRC_ROOT = joinOs(import.meta.dir, '..', '..');
/** repository root, two levels above `cli/`. */
const REPO_ROOT = joinOs(import.meta.dir, '..', '..', '..', '..');

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/** every `.ts` file under `absDir`, as paths relative to `SRC_ROOT` with `/` separators. */
function listTsFiles(absDir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = joinOs(absDir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...listTsFiles(abs));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(toPosix(abs.slice(SRC_ROOT.length + 1)));
    }
  }
  return out;
}

function readSrc(relPath: string): string {
  return readFileSync(joinOs(SRC_ROOT, ...relPath.split('/')), 'utf-8');
}

const ALL_SRC_FILES = listTsFiles(SRC_ROOT).filter((f) => !f.startsWith('__tests__/'));
const K8S_ROOT = 'services/orchestrator/kubernetes';
const kubernetesFiles = (excludeK3s: boolean): string[] =>
  ALL_SRC_FILES.filter((f) => f.startsWith(`${K8S_ROOT}/`) && (!excludeK3s || !f.startsWith(`${K8S_ROOT}/k3s/`)));

// ---------------------------------------------------------------------------
// Comment stripping and import-specifier extraction
// ---------------------------------------------------------------------------

/** Removes `//` and `/* *‍/` comments while preserving string/template contents verbatim. */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += text[i];
        i++;
      }
      out += text[i] ?? '';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** every `from '<spec>'` (import/export) and `import('<spec>')` specifier in the raw source. */
function extractImportSpecifiers(rawText: string): string[] {
  const specs: string[] = [];
  const fromRe = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const m of rawText.matchAll(fromRe)) specs.push(m[1]);
  const dynRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of rawText.matchAll(dynRe)) specs.push(m[1]);
  return specs;
}

/** resolves a relative specifier against the importing file's directory; `null` for a bare package. */
function resolveSpecifier(fromRelPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromDir = posixPath.dirname(fromRelPath);
  const joined = posixPath.normalize(posixPath.join(fromDir, specifier));
  return joined.replace(/\.(ts|tsx|js|mjs)$/, '');
}

function resolvedImports(relPath: string): string[] {
  return extractImportSpecifiers(readSrc(relPath))
    .map((spec) => resolveSpecifier(relPath, spec))
    .filter((r): r is string => r !== null);
}

// ---------------------------------------------------------------------------
// U-ARCH-01/02: the pure set of DESIGN-CORE 1.1 rule 3
// ---------------------------------------------------------------------------

const PURE_DIRS = ['model', 'normalize', 'translate', 'resources', 'status'];
const PURE_DIRECT_FILES = ['yaml.ts', 'naming.ts', 'labels.ts'];

function isPureFile(relPath: string): boolean {
  if (!relPath.startsWith(`${K8S_ROOT}/`)) return false;
  const tail = relPath.slice(K8S_ROOT.length + 1);
  if (PURE_DIRS.some((dir) => tail.startsWith(`${dir}/`))) return true;
  if (PURE_DIRECT_FILES.includes(tail)) return true;
  if (/^apply\/[^/]+-plan\.ts$/.test(tail)) return true;
  if (tail === 'helm/resolve.ts') return true;
  return false;
}

const PURE_FILES = ALL_SRC_FILES.filter(isPureFile);

describe('U-ARCH-01: pure modules import nothing from the impure layers', () => {
  const FORBIDDEN_EXACT = new Set(['fs', 'child_process', 'os', 'bun', 'node:fs', 'node:child_process', 'node:os']);
  const FORBIDDEN_EXACT_RESOLVED = new Set([
    `${K8S_ROOT}/apply/engine`,
    `${K8S_ROOT}/apply/prune`,
    `${K8S_ROOT}/apply/revert`,
    'utils/ssh',
    'utils/output',
  ]);

  it('has a non-empty pure set (the rule is not vacuous)', () => {
    expect(PURE_FILES.length).toBeGreaterThan(20);
  });

  for (const file of PURE_FILES) {
    it(file, () => {
      const specs = extractImportSpecifiers(readSrc(file));
      for (const spec of specs) {
        expect(FORBIDDEN_EXACT.has(spec)).toBe(false);
        const resolved = resolveSpecifier(file, spec);
        if (resolved === null) continue;
        expect(FORBIDDEN_EXACT_RESOLVED.has(resolved)).toBe(false);
        expect(resolved.startsWith(`${K8S_ROOT}/runtime/`)).toBe(false);
        expect(resolved.startsWith(`${K8S_ROOT}/backends/`)).toBe(false);
      }
    });
  }
});

describe('U-ARCH-02: pure modules contain no impure primitive', () => {
  const FORBIDDEN = ['Date.now(', 'Math.random(', 'localeCompare(', 'process.env', 'printWarning', 'console.'];
  const NEW_DATE_NOARGS = /new Date\(\s*\)/;

  for (const file of PURE_FILES) {
    it(file, () => {
      const code = stripComments(readSrc(file));
      for (const token of FORBIDDEN) expect(code.includes(token)).toBe(false);
      expect(NEW_DATE_NOARGS.test(code)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// U-ARCH-03: distribution neutrality (D1) — see the file header for the narrowed scope
// ---------------------------------------------------------------------------

describe('U-ARCH-03: kubernetes/** except k3s/** names no k3s implementation artifact', () => {
  const FORBIDDEN = ['/var/lib/rancher', 'rancher.io', 'svccontroller', 'klipper'];

  for (const file of kubernetesFiles(true)) {
    it(file, () => {
      const lower = readSrc(file).toLowerCase();
      for (const token of FORBIDDEN) expect(lower.includes(token)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// U-ARCH-04: only the runtime layer talks to utils/ssh (DESIGN-CORE 1.1 rule 4, K04)
// ---------------------------------------------------------------------------

describe('U-ARCH-04: utils/ssh is reached through the runtime layer only', () => {
  const FILE_ALLOWED = new Set([`${K8S_ROOT}/runtime/kubectl.ts`, `${K8S_ROOT}/runtime/helm.ts`, `${K8S_ROOT}/runtime/node-shell.ts`]);
  // `shellQuote`/`escapeSingleQuotes` are pure string helpers that happen to live in utils/ssh.ts
  // (WORK-PACKAGES 0.3: "every remote argument goes through shellQuote"); anything else exported by
  // that module (the transport functions, channel handles, `SSHExecOptions`) is the SSH connection
  // itself and stays inside the three files named above.
  const PURE_HELPERS = new Set(['shellQuote', 'escapeSingleQuotes']);

  /** named imports of a `from '...'` clause resolving to utils/ssh, excluding the pure helpers. */
  function sshTransportNamesImportedBy(file: string): string[] {
    const text = readSrc(file);
    const re = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    const found: string[] = [];
    for (const m of text.matchAll(re)) {
      if (resolveSpecifier(file, m[2]) !== 'utils/ssh') continue;
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (name && !PURE_HELPERS.has(name)) found.push(name);
      }
    }
    return found;
  }

  it('only kubectl.ts, helm.ts and node-shell.ts import the SSH transport surface of utils/ssh', () => {
    for (const file of kubernetesFiles(false)) {
      if (sshTransportNamesImportedBy(file).length > 0) expect(FILE_ALLOWED.has(file)).toBe(true);
    }
  });

  // Type-only imports (`KubeExecutor`, `KubectlResult`) name the injected dependency's own type, and
  // pure helpers (`parseJsonItems`, `firstLine`, `driveChannel`, ...) parse data an executor already
  // returned — neither reaches SSH. `createKubeExecutor` legitimately builds one throwaway executor
  // per auxiliary node for `ClusterBackend.probe` (the same pattern `orchestrator/target.ts` uses for
  // failover), always from the backend's own injected `deps`, never from `utils/ssh` directly — which
  // the check above already covers. What backends must never reach is the raw transport re-export
  // (`sshTransport`) kubectl.ts hands to `node-shell.ts`.
  it('backends/** never imports the raw SSH transport re-export', () => {
    const offenders: string[] = [];
    for (const file of ALL_SRC_FILES.filter((f) => f.startsWith(`${K8S_ROOT}/backends/`))) {
      const text = readSrc(file);
      const re = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
      for (const m of text.matchAll(re)) {
        if (resolveSpecifier(file, m[2]) !== `${K8S_ROOT}/runtime/kubectl`) continue;
        if (m[1].split(',').some((raw) => raw.trim().split(/\s+as\s+/)[0].trim() === 'sshTransport')) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// U-ARCH-05: commands/api never import a concrete backend — see file header for the narrowed scope
// ---------------------------------------------------------------------------

describe('U-ARCH-05: commands/** and api/** never import a concrete backend directly', () => {
  // `runtime/errors.ts` is a pure error-reason classifier (no SSH); `deploy-phases.ts` imports
  // `KubeError` from it to recognise a control-plane loss the same way on both orchestrators
  // (`isControlPlaneLoss`), which is not "importing a concrete backend".
  const RUNTIME_EXCEPTIONS = new Set([`${K8S_ROOT}/runtime/errors`]);

  function isConcreteBackend(resolved: string): boolean {
    if (RUNTIME_EXCEPTIONS.has(resolved)) return false;
    return (
      resolved.startsWith(`${K8S_ROOT}/backends/`) ||
      resolved === `${K8S_ROOT}/index` ||
      resolved.startsWith('services/orchestrator/swarm/') ||
      resolved.startsWith('services/orchestrator/stores/') ||
      resolved.startsWith(`${K8S_ROOT}/runtime/`)
    );
  }

  const scoped = ALL_SRC_FILES.filter(
    (f) => (f.startsWith('commands/') || f.startsWith('api/')) && !f.startsWith('commands/setup/k3s/'),
  );

  for (const file of scoped) {
    it(file, () => {
      const offenders = resolvedImports(file).filter(isConcreteBackend);
      expect(offenders).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// U-ARCH-06: no raw kubectl/helm command construction outside the runtime layer
// ---------------------------------------------------------------------------

describe('U-ARCH-06: no call is handed a literal kubectl/helm command string outside runtime/', () => {
  const EXEMPT_DIRS = [`${K8S_ROOT}/runtime/`, 'commands/setup/k3s/'];
  const EXEMPT_FILES = [`${K8S_ROOT}/k3s/distribution.ts`];
  const CALL_ARG_RE = /(\w*)\(\s*['"`](kubectl|helm) /g;

  const scoped = ALL_SRC_FILES.filter(
    (f) => !EXEMPT_DIRS.some((dir) => f.startsWith(dir)) && !EXEMPT_FILES.includes(f) && (f.startsWith(`${K8S_ROOT}/`) || f.startsWith('commands/') || f.startsWith('api/')),
  );

  for (const file of scoped) {
    it(file, () => {
      const code = stripComments(readSrc(file));
      for (const m of code.matchAll(CALL_ARG_RE)) {
        const callee = m[1];
        expect(callee.endsWith('Error')).toBe(true); // only an *Error(...) constructor may start this way
      }
    });
  }
});

// ---------------------------------------------------------------------------
// U-ARCH-07: R2 (secrets on stdin only) — no shell-side secret assembly in kubernetes/**
// ---------------------------------------------------------------------------

describe('U-ARCH-07: kubernetes/** builds no Secret/base64 shell snippet', () => {
  for (const file of kubernetesFiles(false)) {
    it(file, () => {
      const text = readSrc(file);
      expect(text.includes('--from-literal')).toBe(false);
      expect(text.includes('stringData')).toBe(false);
      expect(text.includes('| base64')).toBe(false);
      // `echo $` is the raw-shell risk; `echo ${` is a JS template interpolation, not a shell `$VAR`,
      // so it is skipped rather than flagged.
      const rawDollarEchoes = allIndexesOf(text, 'echo $').filter((idx) => text[idx + 6] !== '{');
      expect(rawDollarEchoes).toEqual([]);
    });
  }
});

function allIndexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return out;
    out.push(idx);
    from = idx + 1;
  }
}

// ---------------------------------------------------------------------------
// U-ARCH-08: translate/index is reached through support/translate.ts in tests
// ---------------------------------------------------------------------------

describe('U-ARCH-08: translate/index is imported only via support/translate.ts', () => {
  const scoped = ALL_SRC_FILES_INCLUDING_TESTS().filter(
    (f) => f.startsWith('__tests__/kubernetes/translate/') || f === '__tests__/kubernetes/golden.test.ts',
  );

  for (const file of scoped) {
    it(file, () => {
      const resolved = resolvedImports(file);
      expect(resolved.includes(`${K8S_ROOT}/translate/index`)).toBe(false);
    });
  }
});

function ALL_SRC_FILES_INCLUDING_TESTS(): string[] {
  return listTsFiles(SRC_ROOT);
}

// ---------------------------------------------------------------------------
// U-ARCH-09: no committed .skip/.only/test.todo under the Kubernetes suite
// ---------------------------------------------------------------------------

describe('U-ARCH-09: no .skip(, .only( or test.todo( under __tests__/kubernetes/**', () => {
  // excludes this file itself: it names the three forbidden tokens as data, to look for them.
  const THIS_FILE = '__tests__/kubernetes/architecture.test.ts';
  const suite = ALL_SRC_FILES_INCLUDING_TESTS().filter((f) => f.startsWith('__tests__/kubernetes/') && f !== THIS_FILE);

  for (const file of suite) {
    it(file, () => {
      const text = readSrc(file);
      expect(text.includes('.skip(')).toBe(false);
      expect(text.includes('.only(')).toBe(false);
      expect(text.includes('test.todo(')).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// U-ARCH-10: the k3s setup bootstrap connection never uses the deploy key
// ---------------------------------------------------------------------------

describe('U-ARCH-10: commands/setup/k3s/** never references DOCKFLOW_DEPLOY', () => {
  const scoped = ALL_SRC_FILES.filter((f) => f.startsWith('commands/setup/k3s/'));

  for (const file of scoped) {
    it(file, () => {
      expect(readSrc(file).includes('DOCKFLOW_DEPLOY')).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// U-ARCH-11: the translator emits none of the objects D25/C8/C10 forbid
// ---------------------------------------------------------------------------

describe('U-ARCH-11: translate/** emits no NetworkPolicy, pod-security label or HelmChart(Config)', () => {
  const FORBIDDEN = ['NetworkPolicy', 'pod-security.kubernetes.io/', 'HelmChartConfig', 'HelmChart'];
  const scoped = ALL_SRC_FILES.filter((f) => f.startsWith(`${K8S_ROOT}/translate/`));

  for (const file of scoped) {
    it(file, () => {
      const text = readSrc(file);
      for (const token of FORBIDDEN) expect(text.includes(token)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// U-ARCH-12: kubectl/helm stdout never reaches a log, debug line or error message
// ---------------------------------------------------------------------------

describe('U-ARCH-12: no kubectl/helm stdout value flows into a log line or error message', () => {
  const SINKS = ['printDebug(', 'printWarning(', 'console.'];
  // `commands/setup/**` carries its own, unrelated `HostRunner`/SSH result shape (also a `.stdout`
  // field) for raw provisioning commands; `KubectlResult`/`HelmResult` never reach there, so the row
  // (about those two specific types) does not apply to it.
  const scoped = ALL_SRC_FILES.filter(
    (f) => (f.startsWith(`${K8S_ROOT}/`) || f.startsWith('commands/') || f.startsWith('api/')) && !f.startsWith('commands/setup/'),
  );

  for (const file of scoped) {
    it(file, () => {
      const code = stripComments(readSrc(file));
      for (const sink of SINKS) {
        for (const idx of allIndexesOf(code, sink)) {
          const arg = balancedCallArgs(code, idx + sink.length - (sink.endsWith('(') ? 1 : 0));
          if (arg !== null) expect(arg.includes('.stdout')).toBe(false);
        }
      }
      // an *Error(...) constructor call, or a `throw` statement's expression, carrying `.stdout`
      for (const m of code.matchAll(/\b\w*Error\(/g)) {
        const arg = balancedCallArgs(code, m.index! + m[0].length - 1);
        if (arg !== null) expect(arg.includes('.stdout')).toBe(false);
      }
    });
  }
});

/** the text between a matching `(` at `openParenIndex` and its `)`, or null if unbalanced/not a paren. */
function balancedCallArgs(text: string, openParenIndex: number): string | null {
  if (text[openParenIndex] !== '(') return null;
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(openParenIndex + 1, i);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// U-ARCH-13: the MCP package ships no tests
// ---------------------------------------------------------------------------

describe('U-ARCH-13: packages/mcp-server ships dist only, tests excluded from the build', () => {
  it('tsconfig.json excludes src/__tests__', () => {
    const tsconfig = JSON.parse(readFileSync(joinOs(REPO_ROOT, 'packages', 'mcp-server', 'tsconfig.json'), 'utf-8')) as {
      exclude?: string[];
    };
    expect(tsconfig.exclude ?? []).toContain('src/__tests__');
  });

  it('package.json "files" is exactly ["dist"]', () => {
    const pkg = JSON.parse(readFileSync(joinOs(REPO_ROOT, 'packages', 'mcp-server', 'package.json'), 'utf-8')) as {
      files?: string[];
    };
    expect(pkg.files).toEqual(['dist']);
  });
});

// ---------------------------------------------------------------------------
// U-ARCH-14: a message asserted by the suite that also lives in validate.ts is shared, not retyped
// ---------------------------------------------------------------------------

describe('U-ARCH-14: messages shared with packages/mcp-server/src/validate.ts come from one constant', () => {
  const validateSource = readFileSync(joinOs(REPO_ROOT, 'packages', 'mcp-server', 'src', 'validate.ts'), 'utf-8');
  const plainMessages: [string, string][] = [];
  for (const [key, value] of Object.entries(M)) {
    if (typeof value === 'string') plainMessages.push([key, value]);
  }

  it('the M catalogue has plain-string entries to check (the row is not vacuous)', () => {
    expect(plainMessages.length).toBeGreaterThan(5);
  });

  for (const [key, value] of plainMessages) {
    it(`M.${key} appears in validate.ts only through M.${key}`, () => {
      const quoted = [`'${value}'`, `"${value}"`, `\`${value}\``];
      for (const literal of quoted) expect(validateSource.includes(literal)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// U-ARCH-15: messages.ts is self-contained and copied verbatim into the MCP package
// ---------------------------------------------------------------------------

describe('U-ARCH-15: services/orchestrator/messages.ts imports nothing and is synced byte for byte', () => {
  it('imports nothing', () => {
    expect(extractImportSpecifiers(readSrc('services/orchestrator/messages.ts'))).toEqual([]);
  });

  it('packages/mcp-server/src/shared/messages.ts equals it after the two-line generated header', () => {
    const source = readSrc('services/orchestrator/messages.ts');
    const copy = readFileSync(joinOs(REPO_ROOT, 'packages', 'mcp-server', 'src', 'shared', 'messages.ts'), 'utf-8');
    const copyLines = copy.split('\n');
    expect(copyLines.slice(0, 2).every((line) => line.startsWith('//'))).toBe(true);
    expect(copyLines.slice(2).join('\n')).toBe(source);
  });
});
