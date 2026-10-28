import { getHighlighter } from 'fumadocs-core/highlight';

export type Token = { content: string; style?: Record<string, string> };

/**
 * Highlights code into lines of tokens with the themes of the docs' code blocks (github-light and
 * github-dark), so a client component can render the lines itself and still look like the docs.
 */
export async function tokenize(code: string, lang: string): Promise<Token[][]> {
  const hl = await getHighlighter('js', { langs: [lang as never], themes: ['github-light', 'github-dark'] });
  const { tokens } = hl.codeToTokens(code, {
    lang: lang as never,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
  return tokens.map((line) =>
    line.map((t) => ({ content: t.content, style: t.htmlStyle as Record<string, string> | undefined })),
  );
}
