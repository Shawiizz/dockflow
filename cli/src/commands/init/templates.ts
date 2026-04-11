import nunjucks from 'nunjucks';

const njk = nunjucks.configure({ autoescape: false, noCache: true });

export async function loadTemplate(name: string): Promise<string> {
  return Bun.file(new URL(`./templates/${name}`, import.meta.url)).text();
}

export function render(template: string, ctx: Record<string, unknown>): string {
  return njk.renderString(template, ctx);
}
