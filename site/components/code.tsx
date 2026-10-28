import { highlight } from 'fumadocs-core/highlight';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';

/** A highlighted code block outside MDX, rendered at build time, with the same look as in the pages. */
export async function Code({ code, lang, title }: { code: string; lang: string; title?: string }) {
  return highlight(code.trim(), {
    lang,
    components: {
      pre: (props) => (
        <CodeBlock {...props} title={title} className="my-0">
          <Pre>{props.children}</Pre>
        </CodeBlock>
      ),
    },
  });
}
