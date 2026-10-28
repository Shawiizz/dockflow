import type { ReactNode } from 'react';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <HomeLayout
      className="dark:bg-neutral-950 dark:[--color-fd-background:var(--color-neutral-950)] [--color-fd-primary:var(--color-brand)]"
      {...baseOptions()}
      links={[
        { text: 'Documentation', url: '/start/introduction/', active: 'none' },
        { text: 'Quickstart', url: '/start/quickstart/', active: 'none' },
        { text: 'CLI reference', url: '/reference/cli/', active: 'none' },
      ]}
    >
      {children}
    </HomeLayout>
  );
}
