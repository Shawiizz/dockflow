import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { FilePair } from '@/components/file-pair';
import { ReleaseTrack } from '@/components/release-track';
import { currentVersion } from '@/lib/version';
import { tokenize } from '@/lib/tokens';

// The files and outputs on this page are Dockflow's own.

// the Quickstart's two files
const dockflowYml = `version: 1
app: hello

environments:
  production:
    vars:
      DOMAIN: hello.example.com`;

const composeYml = `services:
  web:
    image: nginx:1.27-alpine
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1/"]
      interval: 5s
      timeout: 3s
      retries: 3
    x-dockflow:
      routes:
        - domains: ["\${DOMAIN}"]
          port: 80`;

const docs = [
  {
    title: 'Quickstart',
    text: 'From a Linux server to a first deploy, a second deploy and a rollback.',
    href: '/start/quickstart/',
  },
  {
    title: 'How it works',
    text: 'The CLI, the agent, the switch, the registry and the state on the server.',
    href: '/concepts/how-it-works/',
  },
  { title: 'Deploying from CI', text: 'GitHub Actions, GitLab CI, Jenkins, Buildkite, Bitbucket.', href: '/guides/ci/' },
  { title: 'dockflow.yml', text: 'Every key, with its default.', href: '/reference/dockflow-yml/' },
  { title: 'CLI', text: 'Every command and its options.', href: '/reference/cli/' },
  { title: 'Roadmap', text: 'What works today, and what comes before 1.0.0.', href: '/project/roadmap/' },
];

const pill = 'inline-flex items-center gap-1.5 rounded-lg px-5 py-3 text-sm font-semibold transition-colors';

export default async function HomePage() {
  const [dockflowTokens, composeTokens] = await Promise.all([
    tokenize(dockflowYml, 'yaml'),
    tokenize(composeYml, 'yaml'),
  ]);

  return (
    <main className="flex-1 text-landing-foreground">
      {/* a strip with the current release, on the same background as the rollouts card below */}
      <section className="df-accent-card df-grain relative isolate overflow-hidden">
        <div className="mx-auto flex min-h-[180px] w-full max-w-[1400px] flex-wrap items-center justify-between gap-6 px-6 py-10 md:min-h-[200px] md:px-12">
          <p className="text-3xl font-semibold tracking-tight md:text-5xl">Dockflow {currentVersion()}</p>
          <Link href="/start/quickstart/" className={`${pill} bg-white/90 text-neutral-900 hover:bg-white`}>
            Quickstart <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      <div className="mx-auto w-full max-w-[1400px] px-6 md:px-12">
        <p className="mt-20 max-w-6xl text-3xl leading-snug font-light tracking-tight md:text-4xl xl:text-5xl">
          Dockflow deploys a <span className="font-medium text-brand">Docker Compose</span> app to your own server over
          SSH. You keep your <span className="font-medium text-brand">compose.yml</span>, add a small{' '}
          <span className="font-medium text-brand">dockflow.yml</span>, and run{' '}
          <span className="font-medium text-brand">dockflow deploy</span> from your laptop or from CI.
        </p>

        <section className="mt-20 rounded-2xl border bg-fd-card p-6 md:p-8">
          <h2 className="text-2xl font-semibold tracking-tight">Two files.</h2>
          <p className="mt-3 max-w-3xl text-fd-muted-foreground">
            <code className="df-inline-code">compose.yml</code> is a standard Compose file;{' '}
            <code className="df-inline-code">dockflow.yml</code> adds what a deploy needs. Choose a line to see how they
            work together. <code className="df-inline-code">dockflow init</code> writes both.
          </p>
          <div className="mt-6">
            <FilePair dockflow={dockflowTokens} compose={composeTokens} />
          </div>
          <Link
            href="/start/quickstart/"
            className="mt-2 inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
          >
            Quickstart <ArrowRight className="size-3.5" />
          </Link>
        </section>

        <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="df-accent-card df-grain relative isolate overflow-hidden rounded-2xl p-8">
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
              The new container starts next to the old one.
            </h2>
            <p className="mt-5 text-base leading-relaxed opacity-90">
              Once it is healthy, traffic moves to it, the old container gets 30 seconds to finish the requests in
              flight, and then it stops.
            </p>
            <p className="mt-4 text-base leading-relaxed opacity-90">
              If a deploy fails, for example because the new container never becomes healthy, Dockflow switches back to
              the previous containers on its own and exits with code 8.
            </p>
            <Link href="/concepts/rollouts/" className={`${pill} mt-8 bg-white/90 text-neutral-900 hover:bg-white`}>
              Rollouts <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="flex min-w-0 flex-col justify-between gap-10 rounded-2xl border bg-fd-card p-6 md:p-8">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">A rollback is a release too.</h2>
              <p className="mt-3 text-fd-muted-foreground">
                <code className="df-inline-code">dockflow rollback</code> restores the previous release, with the same
                zero-downtime switch, from the image that is still on the server: nothing is rebuilt or downloaded.
              </p>
            </div>
            <ReleaseTrack />
          </div>
        </section>

        <section className="mt-20 mb-16 border-t pt-10">
          <h2 className="text-xl font-semibold tracking-tight">Documentation</h2>
          <ul className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((d) => (
              <li key={d.href}>
                <Link href={d.href} className="group block">
                  <span className="font-medium underline-offset-4 group-hover:underline">{d.title}</span>
                  <span className="mt-1 block text-sm text-fd-muted-foreground">{d.text}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
