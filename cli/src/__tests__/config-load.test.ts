import { describe, expect, it } from 'bun:test';
import { getLayout, loadConfig } from '../utils/config';
import { ConfigError, ErrorCode } from '../utils/errors';

// `content` is parsed without reading the project's files; it is a rendered dockflow.yml in the flat layout
const FILE = getLayout().type === 'flat' ? 'dockflow.yml' : 'config.yml';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('loadConfig: an existing but invalid file', () => {
  it('returns null by default, so a caller can report it its own way', () => {
    expect(loadConfig({ content: 'project_name: 42\n', silent: true })).toBeNull();
  });

  it('is a ConfigError naming each schema issue when strict', () => {
    const error = thrown(() => loadConfig({ content: 'project_name: 42\n', strict: true }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(ErrorCode.CONFIG_INVALID);
    expect((error as ConfigError).message).toStartWith(`${FILE} is invalid:\n  project_name: `);
  });

  it('is a ConfigError when strict and the YAML does not parse', () => {
    const error = thrown(() => loadConfig({ content: 'project_name: [unclosed\n', strict: true }));
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toStartWith(`${FILE} cannot be read: `);
  });
});
