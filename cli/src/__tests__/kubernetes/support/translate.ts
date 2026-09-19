// translateChecked (design-07 2.2, design-02 14.5): translateStack followed by the structural and
// semantic validation of every object it returns. The only import of translateStack in the tests
// (U-ARCH-08).

import { expect } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type { CanonicalStack } from '../../../services/orchestrator/kubernetes/model/types';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import { type TranslateOptions, translateStack } from '../../../services/orchestrator/kubernetes/translate';
import { type TranslateOptionsOverrides, translateOptions } from './builders';
import { failures, formatIssues, validateArtifact } from './schema/semantic';

export interface TranslateValidation {
  /**
   * Names the objects may reference without containing them, on top of the stack's external
   * volumes, secrets and configs: the sibling role's Services and Middlewares (design-02 14.5).
   */
  externalNames?: readonly string[];
  /** SEM-071: an unresolved middleware reference fails; default true */
  strictMiddlewares?: boolean;
  skipRules?: readonly string[];
}

export interface TranslateChecked {
  objects: ManifestObject[];
  /** the sink's list; it also holds the normalizer's diagnostics when the caller shared its sink */
  diagnostics: Diagnostic[];
  options: TranslateOptions;
}

/** Claim names and object names the stack uses but never creates. */
export function stackExternalNames(stack: CanonicalStack): string[] {
  return [...stack.volumes.filter((v) => v.external).map((v) => v.name), ...stack.files.filter((f) => f.external).map((f) => f.objectName)];
}

/**
 * Translates with builder defaults (design-07 5.1). When no error was reported, every object must
 * pass schema and semantic validation; with an error the objects may be incomplete (T1) and render
 * would never emit them, so they are not validated.
 */
export function translateChecked(
  stack: CanonicalStack,
  overrides: TranslateOptionsOverrides = {},
  validation: TranslateValidation = {},
): TranslateChecked {
  const options = translateOptions(overrides);
  const { objects } = translateStack(stack, options);
  const diagnostics = options.sink.list();
  if (!options.sink.hasErrors()) {
    const issues = validateArtifact(objects, {
      namespace: stack.identity.namespace,
      externalNames: [...stackExternalNames(stack), ...(validation.externalNames ?? [])],
      strictMiddlewares: validation.strictMiddlewares ?? true,
      serverNames: options.serverNames,
      traits: options.traits,
      skipRules: validation.skipRules ?? [],
    });
    expect(formatIssues(failures(issues))).toBe('');
  }
  return { objects, diagnostics, options };
}
