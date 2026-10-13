import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerValidateCommand, resolveValidateEnv } from '../commands/validate';
import { ErrorCode } from '../utils/errors';

describe('resolveValidateEnv', () => {
  it('takes the positional environment', () => {
    expect(resolveValidateEnv('production', undefined)).toBe('production');
  });

  it('takes the --env environment', () => {
    expect(resolveValidateEnv(undefined, 'staging')).toBe('staging');
  });

  it('accepts the same environment given twice', () => {
    expect(resolveValidateEnv('production', 'production')).toBe('production');
  });

  it('is undefined when no environment is given', () => {
    expect(resolveValidateEnv(undefined, undefined)).toBeUndefined();
  });

  it('refuses two different environments with the validation exit code', () => {
    try {
      resolveValidateEnv('production', 'staging');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION_FAILED);
      expect((error as Error).message).toContain('production');
      expect((error as Error).message).toContain('staging');
    }
  });
});

describe('validate command arguments', () => {
  function validateCommand(): Command {
    const program = new Command();
    registerValidateCommand(program);
    return program.commands.find((command) => command.name() === 'validate')!;
  }

  it('declares an optional environment argument and keeps --env', () => {
    const validate = validateCommand();
    expect(validate.registeredArguments.map((argument) => argument.name())).toEqual(['env']);
    expect(validate.registeredArguments[0].required).toBe(false);
    expect(validate.options.map((option) => option.long)).toContain('--env');
  });
});
