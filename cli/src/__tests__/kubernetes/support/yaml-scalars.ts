// Catalogue of ambiguous YAML scalars (design-07 8.2 `yamlAmbiguous`): texts that a YAML 1.2
// parser, or the YAML 1.1 rules kubectl and go-yaml apply, read as something other than the same
// string when written unquoted. Emitters must quote them; loaders that keep source text must
// return them verbatim.

/** Read as null when written as a plain scalar. */
export const NULL_SCALARS: readonly string[] = ['~', 'null', 'Null', 'NULL', ''];

/** Read as booleans by YAML 1.2 (`true`/`false` spellings) or YAML 1.1 (`yes`, `on`, `y`, ...). */
export const BOOLEAN_SCALARS: readonly string[] = [
  'true',
  'True',
  'TRUE',
  'false',
  'False',
  'FALSE',
  'yes',
  'Yes',
  'YES',
  'no',
  'No',
  'NO',
  'on',
  'On',
  'ON',
  'off',
  'Off',
  'OFF',
  'y',
  'Y',
  'n',
  'N',
];

/** Read as numbers by YAML 1.2 or YAML 1.1 (octal, hex, binary, underscores, sexagesimal, special floats). */
export const NUMBER_SCALARS: readonly string[] = [
  '0',
  '-0',
  '010',
  '0777',
  '0o17',
  '0x1F',
  '0b101',
  '1e3',
  '1E3',
  '-1.5e-3',
  '1_000',
  '.5',
  '+.5',
  '1.',
  '+1',
  '1:30',
  '190:20:30',
  '.inf',
  '-.Inf',
  '+.INF',
  '.nan',
  '.NaN',
];

/** Read as timestamps by YAML 1.1. */
export const TIMESTAMP_SCALARS: readonly string[] = ['2001-12-14', '2001-12-14t21:59:43.10-05:00', '2001-12-14 21:59:43.10 -5'];

/** Indicators, comments, flow collections, document markers and significant whitespace. */
export const SYNTAX_SCALARS: readonly string[] = [
  "''",
  '""',
  "'",
  '"',
  ':',
  'a: b',
  'a #b',
  '- x',
  '-',
  '? x',
  '# x',
  '! x',
  '!!str x',
  '&a',
  '*a',
  '%x',
  '@x',
  '`x',
  '|',
  '>',
  '{a}',
  '[a]',
  ', x',
  '<<',
  '=',
  '---',
  '...',
  ' leading',
  'trailing ',
  ' ',
];

/** Every ambiguous scalar, deduplicated, in catalogue order. */
export const AMBIGUOUS_SCALARS: readonly string[] = [
  ...new Set([...NULL_SCALARS, ...BOOLEAN_SCALARS, ...NUMBER_SCALARS, ...TIMESTAMP_SCALARS, ...SYNTAX_SCALARS]),
];
