import { llms, loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { remarkVersion } from './remark-version';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    // the default preset, with {{version}} replaced first, before headings and search see the text
    mdxOptions: applyMdxPreset({ remarkPlugins: (v) => [remarkVersion, ...v] }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// The pages are served from the root of the site: content/docs/start/installation.mdx is /start/installation/.
export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText('processed')}`,
});
