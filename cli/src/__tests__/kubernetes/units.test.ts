import { describe, expect, it } from 'bun:test';
import {
  ARCH,
  canonicalQuantity,
  ceilSeconds,
  cpuQuantity,
  formatQuantity,
  isAbsolutePosixPath,
  isArchName,
  isCidr,
  isDnsLabel,
  isDnsSubdomain,
  isIp,
  isLabelKey,
  isLabelValue,
  isReservedKey,
  isSecretDataKey,
  isServiceKey,
  isSysctlName,
  memoryQuantity,
  parseBool,
  parseBytes,
  parseDurationMs,
  parseFileMode,
  parseIntStrict,
  parseMilliCpu,
  parseQuantity,
} from '../../services/orchestrator/kubernetes/model/units';

describe('parseDurationMs (U-UNITS-01)', () => {
  it('parses Go durations to whole milliseconds', () => {
    expect(parseDurationMs('1m30s')).toBe(90000);
    expect(parseDurationMs('1.5s')).toBe(1500);
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('2h')).toBe(7200000);
    expect(parseDurationMs('0s')).toBe(0);
  });

  it('rounds sub-millisecond durations up (design-01 2.5), so 1us is 1 ms rather than 0.001', () => {
    expect(parseDurationMs('1us')).toBe(1);
  });

  it('rejects unknown units, empty input, negative values and malformed numbers', () => {
    expect(parseDurationMs('10x')).toBeNull();
    expect(parseDurationMs('')).toBeNull();
    expect(parseDurationMs('-1s')).toBe('negative');
    expect(parseDurationMs('1.2.3s')).toBeNull();
  });
});

describe('parseDurationMs (design-01 UNIT-01, UNIT-02)', () => {
  it('UNIT-01: valid durations', () => {
    const cases: [string, number][] = [
      ['30s', 30000],
      ['1m30s', 90000],
      ['1.5s', 1500],
      ['500ms', 500],
      ['1500us', 2],
      ['.5s', 500],
      ['5.s', 5000],
      ['0', 0],
      ['1h5m30s20ms', 3930020],
    ];
    for (const [input, ms] of cases) expect([input, parseDurationMs(input)]).toEqual([input, ms]);
  });

  it('UNIT-02: invalid, negative, signed, micro and overflowing durations', () => {
    const cases: [string, number | null | 'negative' | 'overflow'][] = [
      ['30', null],
      ['s', null],
      ['.s', null],
      ['1d', null],
      ['-1s', 'negative'],
      ['+1s', 1000],
      ['1\u{b5}s', 1],
      ['9999999999h', 'overflow'],
    ];
    for (const [input, expected] of cases) expect([input, parseDurationMs(input)]).toEqual([input, expected]);
  });

  it('accepts both micro signs Go accepts', () => {
    expect(parseDurationMs('1\u{b5}s')).toBe(1);
    expect(parseDurationMs('1\u{3bc}s')).toBe(1);
  });

  it('accepts a bare zero with a sign, like Go', () => {
    expect(parseDurationMs('+0')).toBe(0);
    expect(parseDurationMs('-0')).toBe(0);
    expect(parseDurationMs('-0s')).toBe(0);
  });

  it('refuses numbers: the compose schema types durations as strings', () => {
    expect(parseDurationMs(30)).toBeNull();
    expect(parseDurationMs(null)).toBeNull();
  });

  it('B-09: 0s, 1ns, the int64 nanosecond maximum and one above it', () => {
    expect(parseDurationMs('0s')).toBe(0);
    expect(parseDurationMs('1ns')).toBe(1);
    expect(ceilSeconds(parseDurationMs('1ns') as number, 1)).toBe(1);
    expect(parseDurationMs('9223372036854775807ns')).toBe(9223372036855);
    expect(parseDurationMs('9223372036854775808ns')).toBe('overflow');
  });

  it('truncates the fraction to whole nanoseconds, then rounds the total up to milliseconds', () => {
    expect(parseDurationMs('1.000001ms')).toBe(2);
    expect(parseDurationMs('1.0000001ms')).toBe(1);
    expect(parseDurationMs('0.0000001ms')).toBe(0);
    expect(parseDurationMs('1.5h')).toBe(5400000);
  });
});

describe('ceilSeconds (design-02 1.2)', () => {
  it('rounds up to whole seconds with a floor', () => {
    expect(ceilSeconds(0, 0)).toBe(0);
    expect(ceilSeconds(0, 1)).toBe(1);
    expect(ceilSeconds(1, 0)).toBe(1);
    expect(ceilSeconds(1000, 1)).toBe(1);
    expect(ceilSeconds(1001, 1)).toBe(2);
    expect(ceilSeconds(1500, 0)).toBe(2);
    expect(ceilSeconds(500, 0)).toBe(1);
  });
});

describe('parseBytes (U-UNITS-02)', () => {
  it('reads every unit as binary, like go-units RAMInBytes', () => {
    expect(parseBytes('512M')).toBe(536870912);
    expect(parseBytes('512m')).toBe(536870912);
    expect(parseBytes('512mb')).toBe(536870912);
    expect(parseBytes('1g')).toBe(1073741824);
    expect(parseBytes('1GB')).toBe(1073741824);
    expect(parseBytes('1024')).toBe(1024);
    expect(parseBytes('1k')).toBe(1024);
  });

  it('rejects malformed and negative values', () => {
    expect(parseBytes('1.5.g')).toBeNull();
    expect(parseBytes('-1m')).toBeNull();
  });
});

describe('parseBytes (design-01 UNIT-03, UNIT-04)', () => {
  it('UNIT-03: accepted forms', () => {
    const cases: [string | number, number][] = [
      ['2b', 2],
      ['1024kb', 1048576],
      ['2048k', 2097152],
      ['300m', 314572800],
      ['1gb', 1073741824],
      ['1.5g', 1610612736],
      ['512MiB', 536870912],
      ['1 GB', 1073741824],
      ['0', 0],
      [100, 100],
    ];
    for (const [input, bytes] of cases) expect([input, parseBytes(input)]).toEqual([input, bytes]);
  });

  it('UNIT-04: refused forms, exponent notation included on purpose', () => {
    for (const input of ['1mm', '1kibx', '-1m', '1e3', 'm', '1 g b']) expect([input, parseBytes(input)]).toEqual([input, null]);
  });

  it('refuses non-integer and negative numbers', () => {
    expect(parseBytes(1.5)).toBeNull();
    expect(parseBytes(-1)).toBeNull();
    expect(parseBytes(true)).toBeNull();
  });
});

describe('parseMilliCpu (U-UNITS-03, design-01 UNIT-05)', () => {
  it('U-UNITS-03: decimal CPUs to millicores', () => {
    expect(parseMilliCpu('0.5')?.milli).toBe(500);
    expect(parseMilliCpu('2')?.milli).toBe(2000);
  });

  it('UNIT-05: numbers, strings, rounding and refusals', () => {
    expect(parseMilliCpu(0.5)).toEqual({ milli: 500, rounded: false });
    expect(parseMilliCpu('2')).toEqual({ milli: 2000, rounded: false });
    expect(parseMilliCpu(1.25)).toEqual({ milli: 1250, rounded: false });
    expect(parseMilliCpu(0.0005)).toEqual({ milli: 1, rounded: true });
    expect(parseMilliCpu(0)).toEqual({ milli: 0, rounded: false });
    expect(parseMilliCpu('1e-3')).toBeNull();
    expect(parseMilliCpu(-1)).toBeNull();
  });

  it('rejects empty and dot-only input', () => {
    expect(parseMilliCpu('')).toBeNull();
    expect(parseMilliCpu('.')).toBeNull();
    expect(parseMilliCpu('.5')).toEqual({ milli: 500, rounded: false });
  });
});

describe('parseFileMode (U-UNITS-03, design-01 UNIT-06)', () => {
  it('U-UNITS-03: octal source text', () => {
    expect(parseFileMode('0440')?.mode).toBe(288);
    expect(parseFileMode('0o755')?.mode).toBe(493);
  });

  it('UNIT-06: numbers converted by the loader, octal strings, decimal look-alikes, refusals', () => {
    expect(parseFileMode(288)).toEqual({ mode: 288, decimalLooksOctal: false });
    expect(parseFileMode('0440')).toEqual({ mode: 288, decimalLooksOctal: false });
    expect(parseFileMode('440')).toEqual({ mode: 288, decimalLooksOctal: false });
    expect(parseFileMode('0o440')).toEqual({ mode: 288, decimalLooksOctal: false });
    expect(parseFileMode(440)).toEqual({ mode: 440, decimalLooksOctal: true });
    expect(parseFileMode('999')).toBeNull();
    expect(parseFileMode(0o10000)).toBeNull();
  });
});

describe('parseBool (design-01 UNIT-07) and parseIntStrict', () => {
  it('UNIT-07', () => {
    expect(parseBool('TRUE')).toEqual({ value: true, yaml11: false });
    expect(parseBool('off')).toEqual({ value: false, yaml11: true });
    expect(parseBool('1')).toBeNull();
  });

  it('booleans pass through; YAML 1.1 spellings are flagged', () => {
    expect(parseBool(true)).toEqual({ value: true, yaml11: false });
    expect(parseBool('Yes')).toEqual({ value: true, yaml11: true });
    expect(parseBool('n')).toEqual({ value: false, yaml11: true });
    expect(parseBool(1)).toBeNull();
  });

  it('parseIntStrict accepts integers as numbers or decimal strings inside the range', () => {
    expect(parseIntStrict(3, 0, 10)).toBe(3);
    expect(parseIntStrict('3', 0, 10)).toBe(3);
    expect(parseIntStrict('-3', -5, 0)).toBe(-3);
    expect(parseIntStrict(2147483647, 0, 2147483647)).toBe(2147483647);
    expect(parseIntStrict(2147483648, 0, 2147483647)).toBeNull();
    expect(parseIntStrict('3.0', 0, 10)).toBeNull();
    expect(parseIntStrict(1.5, 0, 10)).toBeNull();
    expect(parseIntStrict('', 0, 10)).toBeNull();
    expect(parseIntStrict('0x10', 0, 100)).toBeNull();
  });
});

describe('quantities (U-UNITS-03, design-02 1.2, DESIGN-CORE 4.2 rule 5)', () => {
  it('U-UNITS-03: memory in canonical binary form, never a lowercase m', () => {
    expect(memoryQuantity(536870912)).toBe('512Mi');
    expect(memoryQuantity(1073741824)).toBe('1Gi');
    expect(memoryQuantity(1536)).toBe('1536');
    expect(memoryQuantity(536870912)).not.toMatch(/m$/);
  });

  it('design-02 1.2 table', () => {
    expect([0, 500, 2000, 1, 12500].map(cpuQuantity)).toEqual(['0', '500m', '2', '1m', '12500m']);
    expect(memoryQuantity(0)).toBe('0');
    expect(memoryQuantity(536870912)).toBe('512Mi');
    expect(memoryQuantity(1073741824)).toBe('1Gi');
    expect(memoryQuantity(12 * 1024 ** 3 + 1)).toBe('12884901889');
  });

  it('emits 1000 bytes in the canonical form the API server returns (1k), not "1000"', () => {
    // design-02 1.2 lists "1000"; resource.Quantity canonicalizes it to "1k", and rule 5 requires
    // the manifest to be byte-comparable with the live object
    expect(memoryQuantity(1000)).toBe('1k');
    expect(canonicalQuantity(memoryQuantity(1000))).toBe(memoryQuantity(1000));
  });

  it('uses the largest binary suffix with an integer amount', () => {
    expect(memoryQuantity(1024)).toBe('1Ki');
    expect(memoryQuantity(1536 * 1024)).toBe('1536Ki');
    expect(memoryQuantity(1024 ** 4)).toBe('1Ti');
    expect(memoryQuantity(1024 ** 5)).toBe('1Pi');
    expect(memoryQuantity(1023)).toBe('1023');
    expect(memoryQuantity(1025)).toBe('1025');
  });

  it('canonicalizes like apimachinery resource.Quantity across the suffix table', () => {
    const cases: [string, string][] = [
      ['0', '0'],
      ['0m', '0'],
      ['0Ki', '0'],
      ['-0', '0'],
      ['1n', '1n'],
      ['1u', '1u'],
      ['1m', '1m'],
      ['1', '1'],
      ['1k', '1k'],
      ['1M', '1M'],
      ['1G', '1G'],
      ['1T', '1T'],
      ['1P', '1P'],
      ['1E', '1E'],
      ['1Ki', '1Ki'],
      ['1Mi', '1Mi'],
      ['1Gi', '1Gi'],
      ['1Ti', '1Ti'],
      ['1Pi', '1Pi'],
      ['1Ei', '1Ei'],
      ['1024Mi', '1Gi'],
      ['1024Ki', '1Mi'],
      ['1000Ki', '1000Ki'],
      ['1.5Gi', '1536Mi'],
      ['1.5Ki', '1536'],
      ['0.5Ki', '512'],
      ['0.1Ki', '102400m'],
      ['1.1Ki', '1126400m'],
      ['1000m', '1'],
      ['1500m', '1500m'],
      ['0.5', '500m'],
      ['.5', '500m'],
      ['5.', '5'],
      ['5.0', '5'],
      ['1.5', '1500m'],
      ['0.001', '1m'],
      ['0.0001', '100u'],
      ['1000', '1k'],
      ['1500', '1500'],
      ['1000000', '1M'],
      ['1500000', '1500k'],
      ['1000n', '1u'],
      ['1.5n', '2n'],
      ['0.1n', '1n'],
      ['1e3', '1e3'],
      ['1E3', '1e3'],
      ['1e-3', '1e-3'],
      ['12e2', '1200'],
      ['12e-1', '1200e-3'],
      ['100e-2', '1'],
      ['+1', '1'],
      ['-1', '-1'],
      ['-1.5Gi', '-1536Mi'],
      ['-500m', '-500m'],
    ];
    for (const [input, canonical] of cases) expect([input, canonicalQuantity(input)]).toEqual([input, canonical]);
  });

  it('caps BinarySI values at the int64 maximum like apimachinery', () => {
    expect(canonicalQuantity('8Ei')).toBe('9223372036854775807');
  });

  it('rejects text that is not a quantity', () => {
    for (const input of ['', 'Ki', '1i', '1.2.3', '1 Mi', '1Mb', 'abc', '1e', 'e3', '1KiB', '0x10', '--1', '1.5e3.5', '1ki', '1K']) {
      expect([input, canonicalQuantity(input)]).toEqual([input, null]);
    }
  });

  it('every canonical form is a fixed point', () => {
    for (const input of ['1Gi', '1536Mi', '500m', '1k', '1e3', '1200e-3', '102400m', '9223372036854775807']) {
      expect(canonicalQuantity(input)).toBe(input);
    }
  });

  it('parseQuantity keeps the exact value and the format of the suffix', () => {
    expect(parseQuantity('1.5Gi')).toEqual({ negative: false, mantissa: 16106127360n, scale: -1, format: 'BinarySI' });
    expect(parseQuantity('250m')).toEqual({ negative: false, mantissa: 250n, scale: -3, format: 'DecimalSI' });
    expect(parseQuantity('-2e3')).toEqual({ negative: true, mantissa: 2n, scale: 3, format: 'DecimalExponent' });
    expect(formatQuantity({ negative: false, mantissa: 15n, scale: -12, format: 'DecimalSI' })).toBe('1n');
  });
});

describe('validators (design-01 2.13, UNIT-19)', () => {
  it('UNIT-19: isSecretDataKey', () => {
    const cases: [string, boolean][] = [
      ['DB_HOST', true],
      ['a.b-c', true],
      ['1X', true],
      ['..x', false],
      ['A B', false],
      ['A:B', false],
    ];
    for (const [input, valid] of cases) expect([input, isSecretDataKey(input)]).toEqual([input, valid]);
    expect(isSecretDataKey('.')).toBe(false);
    expect(isSecretDataKey('..')).toBe(false);
    expect(isSecretDataKey('.env')).toBe(true);
    expect(isSecretDataKey('')).toBe(false);
    expect(isSecretDataKey('a'.repeat(253))).toBe(true);
    expect(isSecretDataKey('a'.repeat(254))).toBe(false);
  });

  it('isServiceKey follows the compose key grammar', () => {
    expect(isServiceKey('web_app')).toBe(true);
    expect(isServiceKey('Api.V2')).toBe(true);
    expect(isServiceKey('a b')).toBe(false);
    expect(isServiceKey('')).toBe(false);
  });

  it('isLabelKey: optional DNS prefix of at most 253, name part of at most 63', () => {
    expect(isLabelKey('tier')).toBe(true);
    expect(isLabelKey('app.kubernetes.io/name')).toBe(true);
    expect(isLabelKey('example.com/Some_Key.1')).toBe(true);
    expect(isLabelKey('a'.repeat(63))).toBe(true);
    expect(isLabelKey('a'.repeat(64))).toBe(false);
    expect(isLabelKey(`${'a.'.repeat(126)}a/x`)).toBe(true);
    expect(isLabelKey(`${'a.'.repeat(127)}a/x`)).toBe(false);
    expect(isLabelKey('Example.com/x')).toBe(false);
    expect(isLabelKey('-x')).toBe(false);
    expect(isLabelKey('x/')).toBe(false);
    expect(isLabelKey('a/b/c')).toBe(false);
  });

  it('isLabelValue: empty or at most 63 alphanumerics with inner - _ .', () => {
    expect(isLabelValue('')).toBe(true);
    expect(isLabelValue('v1.2_3-x')).toBe(true);
    expect(isLabelValue('a'.repeat(63))).toBe(true);
    expect(isLabelValue('a'.repeat(64))).toBe(false);
    expect(isLabelValue('-a')).toBe(false);
    expect(isLabelValue('a b')).toBe(false);
  });

  it('isReservedKey matches the Dockflow prefix only', () => {
    expect(isReservedKey('dockflow.shawiizz.dev/stack')).toBe(true);
    expect(isReservedKey('dockflow.shawiizz.dev')).toBe(false);
    expect(isReservedKey('app.kubernetes.io/name')).toBe(false);
  });

  it('DNS labels and subdomains', () => {
    expect(isDnsLabel('web-1')).toBe(true);
    expect(isDnsLabel('Web')).toBe(false);
    expect(isDnsLabel('a'.repeat(64))).toBe(false);
    expect(isDnsSubdomain('fast-ssd.example.com')).toBe(true);
    expect(isDnsSubdomain('a..b')).toBe(false);
    expect(isDnsSubdomain(`${'a.'.repeat(126)}a`)).toBe(true);
    expect(isDnsSubdomain(`${'a.'.repeat(127)}a`)).toBe(false);
  });

  it('isSysctlName', () => {
    expect(isSysctlName('net.core.somaxconn')).toBe(true);
    expect(isSysctlName('net/ipv4/ip_forward')).toBe(true);
    expect(isSysctlName('Net.core')).toBe(false);
    expect(isSysctlName('net..core')).toBe(false);
  });

  it('isIp and isCidr accept IPv4 and IPv6', () => {
    expect(isIp('10.0.0.5')).toBe(true);
    expect(isIp('::1')).toBe(true);
    expect(isIp('fe80::1')).toBe(true);
    expect(isIp('256.0.0.1')).toBe(false);
    expect(isIp('10.0.0.0/8')).toBe(false);
    expect(isCidr('10.0.0.0/8')).toBe(true);
    expect(isCidr('2001:db8::/32')).toBe(true);
    expect(isCidr('10.0.0.5')).toBe(false);
  });

  it('isAbsolutePosixPath', () => {
    expect(isAbsolutePosixPath('/srv/data')).toBe(true);
    expect(isAbsolutePosixPath('srv/data')).toBe(false);
    expect(isAbsolutePosixPath('/a\0b')).toBe(false);
  });

  it('ARCH maps the accepted architecture names to kubernetes.io/arch values', () => {
    expect(ARCH).toEqual({
      x86_64: 'amd64',
      amd64: 'amd64',
      aarch64: 'arm64',
      arm64: 'arm64',
      armv7l: 'arm',
      armhf: 'arm',
      arm: 'arm',
      s390x: 's390x',
      ppc64le: 'ppc64le',
      riscv64: 'riscv64',
    });
    expect(isArchName('x86_64')).toBe(true);
    expect(isArchName('toString')).toBe(false);
    expect(isArchName('mips')).toBe(false);
  });
});
