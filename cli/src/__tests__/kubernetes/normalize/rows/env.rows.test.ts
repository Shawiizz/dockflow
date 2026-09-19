// design-07 4.2 row catalogue, group N-ENV (environment and env_file; design-01 5.3). Every row
// runs the full pipeline (PD-11 (a)).
//
// Differences from the design-07 proposal, resolved by the actual env.ts code:
// - N-ENV-06: a required missing env_file is the shipped code `files.not-found` (the general file
//   read failure), not a distinct `env.file-missing`.
// - N-ENV-08: a duplicate list key is NOT warned about by env.ts: `readListOrDict` (shared with
//   labels) reports it as `values.duplicate-key` (info), which is what the row asserts.
// - N-ENV-10: an invalid name is the shipped code `env.invalid-name`, reported once the value layer
//   accepts the entry (a `A=B` key or an empty name is `values.empty-key`, reported by the value
//   layer before `env.invalid-name` ever sees it); this row uses a name value.ts's list_or_dict
//   passes through (non-empty, no `=`) but that is not a valid Secret data key.

import { type NormalizeRow, runNormalizeRows } from '../../support/rows';

const rows: NormalizeRow[] = [
  {
    id: 'N-ENV-01',
    title: 'map and list forms of environment are identical',
    compose: 'image: nginx:1.27\nenvironment: {A: "1", B: "2"}',
    expect: { select: '/services/0/environment', equals: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] },
  },
  {
    id: 'N-ENV-02a',
    title: 'a list entry A= is an empty value',
    compose: 'image: nginx:1.27\nenvironment: ["A="]',
    expect: { select: '/services/0/environment', equals: [{ name: 'A', value: '' }] },
  },
  {
    id: 'N-ENV-02b',
    title: 'a bare list entry A is removed',
    compose: 'image: nginx:1.27\nenvironment: ["A"]',
    expect: [
      { select: '/services/0/environment', equals: [] },
      { diagnostics: [{ severity: 'warning', code: 'env.unset-variable', path: 'services.web.environment[0]' }] },
    ],
  },
  {
    id: 'N-ENV-02c',
    title: 'a null map value is removed',
    compose: 'image: nginx:1.27\nenvironment: {A: null}',
    expect: [
      { select: '/services/0/environment', equals: [] },
      { diagnostics: [{ severity: 'warning', code: 'env.unset-variable', path: 'services.web.environment.A' }] },
    ],
  },
  {
    id: 'N-ENV-03',
    title: 'two env_files defining the same variable: the later file wins',
    compose: 'image: nginx:1.27\nenv_file: [one.env, two.env]',
    input: { files: { 'one.env': 'A=file-one\n', 'two.env': 'A=file-two\n' } },
    expect: { select: '/services/0/environment', equals: [{ name: 'A', value: 'file-two' }] },
  },
  {
    id: 'N-ENV-04',
    title: 'environment wins over env_file',
    compose: 'image: nginx:1.27\nenv_file: one.env\nenvironment: {A: inline}',
    input: { files: { 'one.env': 'A=file\n' } },
    expect: { select: '/services/0/environment', equals: [{ name: 'A', value: 'inline' }] },
  },
  {
    id: 'N-ENV-05',
    title: 'an optional missing env_file is not an error',
    compose: 'image: nginx:1.27\nenv_file: [{path: missing.env, required: false}]',
    expect: [
      { select: '/services/0/environment', equals: [] },
      { diagnostics: [{ severity: 'info', code: 'env_file.optional-missing', path: 'services.web.env_file[0].path' }], exact: true },
    ],
  },
  {
    id: 'N-ENV-06',
    title: 'a required missing env_file is an error',
    compose: 'image: nginx:1.27\nenv_file: [missing.env]',
    expect: { diagnostics: [{ severity: 'error', code: 'files.not-found', path: 'services.web.env_file[0]' }] },
  },
  {
    id: 'N-ENV-07',
    title: 'YAML scalars are kept as their written string form',
    compose: 'image: nginx:1.27\nenvironment: {PORT: "010", ON: "true", RATIO: "1.10", HEX: "0x1F", EXP: "1e3", NUL: null}',
    expect: [
      {
        select: '/services/0/environment',
        equals: [
          { name: 'EXP', value: '1e3' },
          { name: 'HEX', value: '0x1F' },
          { name: 'ON', value: 'true' },
          { name: 'PORT', value: '010' },
          { name: 'RATIO', value: '1.10' },
        ],
      },
      { diagnostics: [{ severity: 'warning', code: 'env.unset-variable', path: 'services.web.environment.NUL' }] },
    ],
  },
  {
    id: 'N-ENV-08',
    title: 'a duplicate list key keeps the last value with an info',
    compose: 'image: nginx:1.27\nenvironment: ["A=1", "A=2"]',
    expect: [
      { select: '/services/0/environment', equals: [{ name: 'A', value: '2' }] },
      { diagnostics: [{ severity: 'info', code: 'values.duplicate-key', path: 'services.web.environment[1]' }], exact: true },
    ],
  },
  {
    id: 'N-ENV-09',
    title: 'a relaxed name with dots and dashes is kept',
    compose: 'image: nginx:1.27\nenvironment: {"my.var-1": "x"}',
    expect: { select: '/services/0/environment', equals: [{ name: 'my.var-1', value: 'x' }] },
  },
  {
    id: 'N-ENV-10',
    title: 'a name with a character Secret data keys reject is an error',
    compose: 'image: nginx:1.27\nenvironment: {"É": "x"}',
    expect: { diagnostics: [{ severity: 'error', code: 'env.invalid-name', path: 'services.web.environment["É"]' }] },
  },
  {
    id: 'N-ENV-11',
    title: 'newlines, tabs, emoji and a long value are byte-identical',
    compose: 'image: nginx:1.27\nenvironment: {A: "line1\\nline2\\r\\nline3\\tend 🚀"}',
    expect: { select: '/services/0/environment', equals: [{ name: 'A', value: 'line1\nline2\r\nline3\tend 🚀' }] },
  },
  {
    id: 'N-ENV-12',
    title: 'env_file grammar: export, quoted values and trailing comments',
    compose: 'image: nginx:1.27\nenv_file: app.env',
    input: { files: { 'app.env': 'export A=1\nB="a b"\nC=\'x\'\n# c\nD=1 # trailing\n' } },
    expect: {
      select: '/services/0/environment',
      equals: [
        { name: 'A', value: '1' },
        { name: 'B', value: 'a b' },
        { name: 'C', value: 'x' },
        { name: 'D', value: '1' },
      ],
    },
  },
  {
    id: 'N-ENV-13',
    title: 'environment entries are sorted by code-unit name',
    compose: 'image: nginx:1.27\nenvironment: {B: "1", a: "2", _x: "3"}',
    expect: {
      select: '/services/0/environment',
      equals: [{ name: 'B', value: '1' }, { name: '_x', value: '3' }, { name: 'a', value: '2' }],
    },
  },
];

runNormalizeRows('normalize/env (N-ENV)', rows);
