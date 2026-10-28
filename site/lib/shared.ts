import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Dockflow';
export const siteUrl = 'https://dockflow.shawiizz.dev';
export const description =
  'Deploy your Docker Compose apps to your own server, with zero downtime, a plan before every change and rollbacks that always finish.';

export const gitConfig = {
  user: 'Shawiizz',
  repo: 'dockflow',
  branch: 'main',
};
export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/** The source of a page on GitHub, from its path under content/docs. */
export function editUrl(path: string) {
  return `${githubUrl}/edit/${gitConfig.branch}/site/content/docs/${path}`;
}

export function sourceUrl(path: string) {
  return `${githubUrl}/blob/${gitConfig.branch}/site/content/docs/${path}`;
}

// Each page's Markdown, for "Copy Markdown" and for LLMs: /llms.mdx/start/installation/content.md
const getContentUrl = createGetUrl('/llms.mdx');

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];
  return { segments, url: getContentUrl(segments, page.locale) };
}
