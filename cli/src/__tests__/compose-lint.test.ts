import { describe, expect, test } from 'bun:test';
import {
  findShellPlaceholders,
  describeShellPlaceholders,
} from '../services/compose-lint';

describe('findShellPlaceholders', () => {
  test('reports a plain placeholder with its line number', () => {
    const compose = [
      'services:',
      '  app:',
      '    ports:',
      '      - "${APP_PORT}:3000"',
    ].join('\n');

    const found = findShellPlaceholders(compose);

    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('APP_PORT');
    expect(found[0].raw).toBe('${APP_PORT}');
    expect(found[0].line).toBe(4);
    expect(found[0].suggestion).toBe('{{ current.env.app_port }}');
  });

  test('ignores the $$ escape, which is a deliberate literal', () => {
    const compose = "    command: sh -c 'echo $${HOSTNAME}'";

    expect(findShellPlaceholders(compose)).toHaveLength(0);
  });

  test('ignores Nunjucks placeholders', () => {
    const compose = '      - "{{ current.env.app_port }}:3000"';

    expect(findShellPlaceholders(compose)).toHaveLength(0);
  });

  test('ignores bare $variables, which nginx and shell scripts use legitimately', () => {
    const compose = '    command: sh -c "echo $HOME && echo $host"';

    expect(findShellPlaceholders(compose)).toHaveLength(0);
  });

  test('handles the default-value and error forms', () => {
    const found = findShellPlaceholders('a: ${APP_PORT:-3000}\nb: ${SECRET:?missing}');

    expect(found.map((p) => p.name)).toEqual(['APP_PORT', 'SECRET']);
    expect(found[0].raw).toBe('${APP_PORT:-3000}');
  });

  test('points root context variables at their own names, not current.env', () => {
    const found = findShellPlaceholders('a: ${ENV}\nb: ${VERSION}');

    expect(found[0].suggestion).toBe('{{ env }}');
    expect(found[1].suggestion).toBe('{{ version }}');
  });

  test('flags keys declared in servers.yml, matching case-insensitively', () => {
    const found = findShellPlaceholders('a: ${APP_PORT}\nb: ${UNKNOWN}', ['app_port']);

    expect(found[0].declared).toBe(true);
    expect(found[1].declared).toBe(false);
  });

  test('reports every occurrence, not just the first', () => {
    const found = findShellPlaceholders('a: ${ONE}\nb: ${TWO}\nc: ${ONE}');

    expect(found).toHaveLength(3);
    expect(found.map((p) => p.line)).toEqual([1, 2, 3]);
  });
});

describe('describeShellPlaceholders', () => {
  test('names the line, the placeholder and the replacement', () => {
    const [line] = describeShellPlaceholders(
      findShellPlaceholders('      - "${APP_PORT}:3000"', ['app_port']),
    );

    expect(line).toContain('line 1');
    expect(line).toContain('${APP_PORT}');
    expect(line).toContain('declared in servers.yml');
    expect(line).toContain('{{ current.env.app_port }}');
  });

  test('returns nothing for a clean file', () => {
    expect(describeShellPlaceholders(findShellPlaceholders('services: {}'))).toEqual([]);
  });
});
