import { replaceSource } from 'fumadocs-core/mdx-plugins/stringifier';
import { currentVersion } from './version';

const marker = '{{version}}';

// the few fields of mdast nodes this plugin reads, so that it needs no package of its own
interface Node {
  type: string;
  value?: string;
  children?: Node[];
  attributes?: { type: string; value?: unknown }[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

type File = Parameters<typeof replaceSource>[0];
type MdastNode = Parameters<typeof replaceSource>[1];

/**
 * Replaces the marker {{version}} with the current release (lib/version.ts) everywhere in a page:
 * text, code blocks, inline code and JSX attributes. In text, MDX reads the marker as the
 * expression `{version}`, which becomes the version as text. The Markdown of the page (search
 * index, llms.txt) is written from the source, so each change is registered there too.
 */
export function remarkVersion() {
  return (tree: Node, file: File) => {
    const version = currentVersion();
    const walk = (node: Node) => {
      if (typeof node.value === 'string' && ['text', 'code', 'inlineCode'].includes(node.type)) {
        if (node.value.includes(marker)) {
          node.value = node.value.replaceAll(marker, version);
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start !== undefined && end !== undefined) {
            replaceSource(file, node as MdastNode, (s) => s.slice(start, end).replaceAll(marker, version));
          }
        }
      }
      for (const attr of node.attributes ?? []) {
        if (attr.type === 'mdxJsxAttribute' && typeof attr.value === 'string') {
          attr.value = attr.value.replaceAll(marker, version);
        }
      }
      node.children?.forEach((child, i, children) => {
        if (
          (child.type === 'mdxTextExpression' || child.type === 'mdxFlowExpression') &&
          child.value?.trim() === '{version}'
        ) {
          const text: Node = { type: 'text', value: version, position: child.position };
          children[i] = child.type === 'mdxTextExpression' ? text : { type: 'paragraph', children: [text], position: child.position };
          replaceSource(file, children[i] as MdastNode, version);
          return;
        }
        walk(child);
      });
    };
    walk(tree);
  };
}
