// The releases of the Quickstart's app, as `dockflow releases production` lists them, drawn as a track:
// one stop per release, the current one lit, and the rollback that release 3 records.

const releases = [
  { seq: 1, version: 'a1b2c3d', status: 'superseded', created: '14:03:11' },
  { seq: 2, version: 'e4f5a6b', status: 'superseded', created: '14:08:02' },
  { seq: 3, version: 'a1b2c3d', status: 'active (rollback to 1)', created: '14:12:40', current: true },
];

export function ReleaseTrack() {
  return (
    <div className="relative">
      <div aria-hidden className="absolute top-[22px] right-0 left-0 h-px bg-fd-border" />
      <ol className="relative grid grid-cols-3 gap-4">
        {releases.map((r) => (
          <li key={r.seq} className="min-w-0">
            <span
              className={
                r.current
                  ? 'grid size-11 place-items-center rounded-xl bg-brand font-mono text-sm font-semibold text-brand-foreground shadow-[0_0_30px_-4px_var(--color-brand)]'
                  : 'grid size-11 place-items-center rounded-xl border bg-fd-card font-mono text-sm text-fd-muted-foreground'
              }
            >
              {r.seq}
            </span>
            <p className="mt-4 font-mono text-sm">{r.version}</p>
            <p className={r.current ? 'mt-1 text-sm font-medium text-brand' : 'mt-1 text-sm text-fd-muted-foreground'}>
              {r.status}
            </p>
            <p className="mt-1 font-mono text-xs text-fd-muted-foreground">2026-10-26 {r.created}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
