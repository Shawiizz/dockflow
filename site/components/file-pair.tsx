'use client';
// The Quickstart's dockflow.yml and compose.yml, in the docs' own code blocks. Lines that work together
// are linked: choosing one (hover, focus or tap), or one of the buttons under the files, highlights
// those lines in both files and shows what Dockflow does with them. The notes quote the Quickstart and
// the Introduction.

import { type CSSProperties, type ReactNode, useState } from 'react';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import type { Token } from '@/lib/tokens';

type FileId = 'dockflow' | 'compose';
interface Group {
  id: string;
  label: string;
  // 1-based line numbers
  dockflow: number[];
  compose: number[];
  note: ReactNode;
}

const code = (s: string) => <code className="df-inline-code">{s}</code>;

const groups: Group[] = [
  {
    id: 'route',
    label: 'The route',
    dockflow: [7],
    compose: [9, 10, 11, 12],
    note: (
      <>
        {code('${DOMAIN}')} takes its value from the environment&apos;s {code('vars')}. The route sends{' '}
        {code('https://hello.example.com')} to port 80 of the container. The {code('x-dockflow')} key adds it, and
        Compose ignores it.
      </>
    ),
  },
  {
    id: 'health',
    label: 'The healthcheck',
    dockflow: [],
    compose: [4, 5, 6, 7, 8],
    note: (
      <>
        The healthcheck tells Dockflow when a new container is ready for traffic. The new container starts next to
        the old one; once it is healthy, traffic moves to it.
      </>
    ),
  },
  {
    id: 'project',
    label: 'The app',
    dockflow: [2, 5],
    compose: [1],
    note: (
      <>
        On the server, an app is a real Compose project: {code('docker compose -p <app>-<env> ps')} and {code('logs')}{' '}
        work on it. Here, the project is {code('hello-production')}.
      </>
    ),
  },
  {
    id: 'server',
    label: 'The environment',
    dockflow: [4],
    compose: [],
    note: <>The server comes from the connection string, so nothing about it appears here.</>,
  },
];

// the code blocks of the docs carry these, from the highlighter
const shikiClass = 'shiki shiki-themes github-light github-dark';
const shikiStyle = {
  '--shiki-light': '#24292e',
  '--shiki-dark': '#e1e4e8',
  '--shiki-light-bg': '#fff',
  '--shiki-dark-bg': '#24292e',
} as CSSProperties;

function File({
  file,
  title,
  lines,
  active,
  onChoose,
}: {
  file: FileId;
  title: string;
  lines: Token[][];
  active: Group;
  onChoose: (g: Group) => void;
}) {
  return (
    <CodeBlock title={title} className={`${shikiClass} my-0`} style={shikiStyle}>
      <Pre>
        <code>
          {lines.map((tokens, i) => {
            const n = i + 1;
            const g = groups.find((x) => x[file].includes(n));
            const on = g?.id === active.id;
            const content = tokens.map((t, k) => (
              <span key={k} style={t.style as CSSProperties}>
                {t.content}
              </span>
            ));
            if (!g)
              return (
                <span key={n} className="line">
                  {content}
                </span>
              );
            const first = g[file][0] === n;
            return (
              <span
                key={n}
                role="button"
                tabIndex={first ? 0 : -1}
                aria-pressed={on}
                aria-label={first ? `${title}: ${g.label.toLowerCase()}` : undefined}
                onMouseEnter={() => onChoose(g)}
                onFocus={() => onChoose(g)}
                onClick={() => onChoose(g)}
                className={`line df-link cursor-pointer outline-none ${on ? 'highlighted' : ''}`}
              >
                {content}
              </span>
            );
          })}
        </code>
      </Pre>
    </CodeBlock>
  );
}

export function FilePair({ dockflow, compose }: { dockflow: Token[][]; compose: Token[][] }) {
  const [active, setActive] = useState<Group>(groups[0]);

  return (
    <div className="df-blue-accent">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <File file="dockflow" title="dockflow.yml" lines={dockflow} active={active} onChoose={setActive} />
        <File file="compose" title="compose.yml" lines={compose} active={active} onChoose={setActive} />
      </div>
      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="What the lines do">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setActive(g)}
            aria-pressed={active.id === g.id}
            className={`inline-flex items-center rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              active.id === g.id
                ? 'border-fd-primary/40 bg-fd-primary/10 text-fd-primary'
                : 'bg-fd-secondary text-fd-secondary-foreground hover:bg-fd-accent'
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>
      <p className="mt-4 min-h-[3.4em] max-w-4xl text-fd-muted-foreground" aria-live="polite">
        {active.note}
      </p>
    </div>
  );
}
