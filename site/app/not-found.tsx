import Link from 'next/link';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
        <p className="font-mono text-sm text-fd-primary">404</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-3 text-fd-muted-foreground">This page does not exist, or it has moved.</p>
        <div className="mt-6 flex gap-3">
          <Link href="/" className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground">
            Home
          </Link>
          <Link href="/start/introduction/" className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-fd-accent">
            Documentation
          </Link>
        </div>
      </main>
    </HomeLayout>
  );
}
