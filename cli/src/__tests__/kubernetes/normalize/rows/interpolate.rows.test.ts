// design-07 4.2 row catalogue, group N-INT (compose interpolation with an empty environment;
// design-01 2.3). Every row runs the full pipeline (PD-11 (a)).
//
// Differences from the design-07 proposal, resolved by the actual interpolate.ts code:
// - N-INT-03: an unset `${VAR}` / `$VAR` is an ERROR `interpolate.unset` (the design-07 proposal's
//   "or error" branch), never a silent warning.
// - N-INT-06: `$(literal)` is kept byte for byte (compose-go: `$(` is not an interpolation form and
//   is never consumed), so it is NOT `interpolate.invalid`; the row asserts the literal is kept.

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-INT-01',
    title: '$$ reduces to a literal $',
    compose: 'image: nginx:1.27\nenvironment:\n  A: "a$$b"',
    expect: { select: '/services/0/environment/0/value', equals: 'a$b' },
  },
  {
    id: 'N-INT-02a',
    title: '${VAR:-fallback} takes the fallback when unset',
    compose: 'image: nginx:1.27\nenvironment:\n  A: "${VAR:-fallback}"',
    expect: { select: '/services/0/environment/0/value', equals: 'fallback' },
  },
  {
    id: 'N-INT-02b',
    title: '${VAR-fallback} takes the fallback when unset',
    compose: 'image: nginx:1.27\nenvironment:\n  A: "${VAR-fallback}"',
    expect: { select: '/services/0/environment/0/value', equals: 'fallback' },
  },
  {
    id: 'N-INT-03a',
    title: '${VAR} unset is an error, emptied',
    compose: 'image: nginx:1.27\nenvironment:\n  A: "${VAR}"',
    expect: [
      { select: '/services/0/environment/0/value', equals: '' },
      { diagnostics: [{ severity: 'error', code: 'interpolate.unset', path: 'services.web.environment.A' }] },
    ],
  },
  {
    id: 'N-INT-03b',
    title: '$VAR unset is an error, emptied',
    compose: 'image: nginx:1.27\nenvironment:\n  A: "$VAR"',
    expect: [
      { select: '/services/0/environment/0/value', equals: '' },
      { diagnostics: [{ severity: 'error', code: 'interpolate.unset', path: 'services.web.environment.A' }] },
    ],
  },
  {
    id: 'N-INT-04',
    title: '${VAR:?message} is a required-variable error, and leaves an unparsable image reference',
    compose: 'image: "myapp:${VAR:?must be set}"',
    expect: {
      diagnostics: [
        { severity: 'error', code: 'interpolate.required', path: 'services.web.image' },
        { severity: 'error', code: 'image.invalid-reference', path: 'services.web.image' },
      ],
    },
  },
  {
    id: 'N-INT-05',
    title: '${VAR:+x} is empty for an unset variable, no diagnostic',
    compose: 'image: nginx:1.27\nenvironment:\n  A: "${VAR:+x}"',
    expect: { select: '/services/0/environment/0/value', equals: '' },
  },
  {
    id: 'N-INT-06',
    title: '$(literal) is not an interpolation form and is kept verbatim',
    compose: 'image: nginx:1.27\nenvironment:\n  A: "$(literal)"',
    expect: { select: '/services/0/environment/0/value', equals: '$(literal)' },
  },
  {
    id: 'N-INT-07',
    title: '$$(literal) reduces the $$ and keeps the rest',
    compose: 'image: nginx:1.27\nenvironment:\n  A: "$$(literal)"',
    expect: { select: '/services/0/environment/0/value', equals: '$(literal)' },
  },
  {
    id: 'N-INT-08a',
    title: '${VAR is unterminated: invalid',
    compose: 'image: nginx:1.27\nworking_dir: "/app/${VAR"',
    expect: { diagnostics: [{ severity: 'error', code: 'interpolate.invalid', path: 'services.web.working_dir' }] },
  },
  {
    id: 'N-INT-08b',
    title: 'a trailing $ is kept, no diagnostic',
    compose: 'image: nginx:1.27\nworking_dir: "/app$"',
    expect: { select: '/services/0/process/workingDir', equals: '/app$' },
  },
  {
    id: 'N-INT-09',
    title: 'the same ${VAR:-fallback} reduction applies under image, command, entrypoint, environment, labels and healthcheck test',
    compose: [
      'image: "nginx:${TAG:-1.29}"',
      'command: ["sh", "-c", "echo ${MSG:-hi}"]',
      'entrypoint: ["/bin/${APP:-app}"]',
      'environment:',
      '  A: "${VAL:-x}"',
      'labels:',
      '  team: "${TEAM:-core}"',
      'healthcheck:',
      '  test: ["CMD-SHELL", "echo ${OK:-ok}"]',
    ].join('\n'),
    expect: [
      { select: '/services/0/image/composeRef', equals: 'nginx:1.29' },
      { select: '/services/0/process/command', equals: ['sh', '-c', 'echo hi'] },
      { select: '/services/0/process/entrypoint', equals: ['/bin/app'] },
      { select: '/services/0/environment/0/value', equals: 'x' },
      { select: '/services/0/containerLabels/team', equals: 'core' },
      { select: '/services/0/healthcheck/test', equals: { type: 'shell', command: 'echo ok' } },
    ],
  },
];

runNormalizeRows('normalize/interpolate (N-INT)', rows);
