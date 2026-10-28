import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';

// The default grid centres the sidebar, the page and the table of contents together, so on a wide
// screen the sidebar floats away from the left edge. Here the sidebar keeps the first column, flush
// left, and the page and its table of contents are centred in the space that remains, as on fumadocs.dev.
const gridTemplate = `"sidebar . header toc ."
"sidebar . toc-popover toc ."
"sidebar . tabs toc ."
"sidebar . main toc ." 1fr / var(--fd-sidebar-col) minmax(0, 1fr) minmax(0, calc(var(--fd-layout-width, 97rem) - var(--fd-sidebar-width) - var(--fd-toc-width))) var(--fd-toc-width) minmax(0, 1fr)`;

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()} containerProps={{ style: { gridTemplate } }}>
      {children}
    </DocsLayout>
  );
}
