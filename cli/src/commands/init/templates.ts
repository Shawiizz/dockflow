import nunjucks from 'nunjucks';

// Standard Nunjucks env for project templates (config.yml, servers.yml)
const njk = nunjucks.configure({ autoescape: false, noCache: true });

// Separate env for CI templates — uses [[ ]] to avoid conflict with ${{ }} GitHub Actions syntax
const njkCI = new nunjucks.Environment(undefined, {
  autoescape: false,
  noCache: true,
  tags: { variableStart: '[[', variableEnd: ']]' },
});

export async function loadTemplate(name: string): Promise<string> {
  return Bun.file(new URL(`./templates/${name}`, import.meta.url)).text();
}

export function render(template: string, ctx: Record<string, unknown>): string {
  return njk.renderString(template, ctx);
}

export function renderCI(template: string, ctx: Record<string, unknown>): string {
  return njkCI.renderString(template, ctx);
}
