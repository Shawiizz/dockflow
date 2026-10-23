/**
 * Compose templates — renders everything under .dockflow/ through Nunjucks, in memory,
 * and resolves the compose file out of the rendered files.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import nunjucks from 'nunjucks';
import { posixRelative, toPosix, walkDir } from '../../utils/fs';
import { describeInsertedPlaceholders, describeShellPlaceholders, findInsertedPlaceholders, findShellPlaceholders } from '../compose-lint';
import { findUndefinedEnvReferences, describeUndefinedEnvReferences } from '../template-lint';
import { getAccessoriesPath, getProjectRoot, getComposePath, getLayout } from '../../utils/config';
import { printDebug, printWarning } from '../../utils/output';
import { ConfigError } from '../../utils/errors';
import { DOCKFLOW_PLUGINS_DIR } from '../../constants';
import type { TemplateContext } from '../../types';
import type { ComposeRenderContext, RenderedComposeResult, RenderedFiles } from './types';

/**
 * Renders every file under .dockflow/ (plugin files excepted) and the custom templates from
 * config.templates, which land at their dest path. Nothing is written to disk.
 *
 * Keys are relative to projectRoot with forward slashes (e.g. ".dockflow/docker/docker-compose.yml").
 * Filenames are kept verbatim: name a file exactly as it should land on the server.
 */
export function renderTemplates(
  projectRoot: string,
  ctx: ComposeRenderContext,
): RenderedFiles {
  const njk = nunjucks.configure({ autoescape: false, noCache: true });
  const dockflowDir = join(projectRoot, '.dockflow');
  const rendered: RenderedFiles = new Map();

  const templateCtx: Record<string, unknown> = {
    ...ctx,
    ...ctx.config,
  };

  // With a server resolved, warn about current.env references that render as empty
  // strings. Without one — a build with no matching environment — every reference is
  // undefined, and the caller has already said so.
  const current = ctx.current as { name?: string; env?: Record<string, unknown> } | undefined;
  const envKeys = current?.env !== null && typeof current?.env === 'object' ? Object.keys(current.env) : null;
  const lint = (file: string, content: string): void => {
    if (!envKeys) return;
    const references = findUndefinedEnvReferences(content, envKeys);
    for (const line of describeUndefinedEnvReferences(file, references, current?.name ?? 'this server')) {
      printWarning(line);
    }
  };

  const render = (file: string, content: string): string => {
    try {
      return njk.renderString(content, templateCtx);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace('(unknown path) ', '');
      throw new ConfigError(`${file}: ${message}`);
    }
  };

  const files = walkDir(dockflowDir);
  let count = 0;

  for (const filePath of files) {
    const relPath = posixRelative(projectRoot, filePath);

    // Plugin files are rendered by the plugin expansion, in the plugin's own
    // scope. Rendering them here would turn every `{{ inputs.x }}` into an empty
    // string and leave the corrupted copy where the build context picks it up.
    if (relPath.startsWith(`${DOCKFLOW_PLUGINS_DIR}/`)) continue;

    const content = readFileSync(filePath, 'utf-8');
    const renderedContent = render(relPath, content);
    lint(relPath, content);

    rendered.set(relPath, renderedContent);
    count++;
  }

  printDebug(`Rendered ${count} file(s) in .dockflow/`);

  // In flat layout, dockflow.yml and the root-level compose and accessories are not
  // inside .dockflow/ so they aren't picked up by the walk above — render them here.
  const layout = getLayout();
  if (layout.type === 'flat') {
    for (const absPath of [layout.configPath, layout.composePath, layout.accessoriesPath]) {
      if (!absPath) continue;
      const relPath = posixRelative(projectRoot, absPath);
      if (!relPath.startsWith('.dockflow/')) {
        const content = readFileSync(absPath, 'utf-8');
        rendered.set(relPath, render(relPath, content));
        lint(relPath, content);
      }
    }
  }

  const templates = ctx.config.templates ?? [];
  for (const tmpl of templates) {
    const src = typeof tmpl === 'string' ? tmpl : tmpl.src;
    const dest = typeof tmpl === 'string' ? tmpl : tmpl.dest;
    const srcPath = join(projectRoot, src);

    if (!existsSync(srcPath)) {
      printDebug(`Custom template not found: ${src}`);
      continue;
    }

    const content = readFileSync(srcPath, 'utf-8');
    const renderedContent = render(src, content);
    lint(src, content);
    rendered.set(toPosix(dest), renderedContent);
    printDebug(`Rendered custom template: ${src} → ${dest}`);
  }

  return rendered;
}

/** A copy of the render context whose strings hold no `$`. */
function stripDollars(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('$', '');
  if (Array.isArray(value)) return value.map(stripDollars);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripDollars(item)]));
  }
  return value;
}

/**
 * Warnings for the `$` placeholders Docker would empty in a stack file.
 *
 * Placeholders are looked for in the file as written, where they are the user's own text.
 * In the rendered file they may be part of an inserted secret.
 */
function placeholderWarnings(
  absPath: string,
  rendered: string,
  renderContext: Record<string, unknown>,
  declaredKeys: string[],
): string[] {
  const written = readFileSync(absPath, 'utf-8');
  const withoutDollars = nunjucks
    .configure({ autoescape: false, noCache: true })
    .renderString(written, stripDollars(renderContext) as object);
  return [
    ...describeShellPlaceholders(findShellPlaceholders(written, declaredKeys)),
    ...describeInsertedPlaceholders(findInsertedPlaceholders(rendered, withoutDollars)),
  ];
}

/**
 * Renders the templates and returns them with the compose content. Throws a ConfigError when no
 * compose file is rendered; with `uploadOnly`, a missing compose file becomes an empty one.
 */
export function renderAndResolveCompose(
  ctx: ComposeRenderContext,
  templateContext?: TemplateContext | null,
  options: { uploadOnly?: boolean } = {},
): RenderedComposeResult {
  const projectRoot = getProjectRoot();

  const fullCtx: ComposeRenderContext = {
    ...ctx,
    current: templateContext?.current ?? {},
    servers: templateContext?.servers ?? {},
    cluster: templateContext?.cluster ?? {},
  };
  const rendered = renderTemplates(projectRoot, fullCtx);
  const renderContext: Record<string, unknown> = { ...fullCtx, ...fullCtx.config };

  const originalComposePath = getComposePath();
  if (!originalComposePath) {
    if (options.uploadOnly) {
      return {
        rendered,
        composeContent: 'services: {}\n',
        composeDirPath: join(projectRoot, '.dockflow', 'docker'),
        projectRoot,
        renderContext,
      };
    }
    throw new ConfigError(
      'No docker-compose.yml found',
      'Expected at docker-compose.yml or .dockflow/docker/docker-compose.yml',
    );
  }

  const composeRelPath = posixRelative(projectRoot, originalComposePath);
  const composeContent = rendered.get(composeRelPath);

  if (composeContent) {
    // Warn rather than fail: an already-working deployment must not be blocked by this.
    const declaredKeys = Object.keys(
      (templateContext?.current as { env?: Record<string, string> } | undefined)?.env ?? {},
    );
    const accessoriesPath = getAccessoriesPath();
    for (const absPath of [originalComposePath, accessoriesPath]) {
      if (!absPath) continue;
      const relPath = posixRelative(projectRoot, absPath);
      const content = rendered.get(relPath);
      if (!content) continue;
      for (const line of placeholderWarnings(absPath, content, renderContext, declaredKeys)) {
        printWarning(`${relPath} ${line}`);
      }
    }
  }
  if (!composeContent) {
    throw new ConfigError(
      'Compose file not found in rendered templates',
      `Expected key "${composeRelPath}" in rendered files map`,
    );
  }

  return {
    rendered,
    composeContent,
    composeDirPath: dirname(originalComposePath),
    projectRoot,
    renderContext,
  };
}
