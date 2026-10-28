type Variant = 'note' | 'tip' | 'success' | 'caution' | 'danger' | 'default';

const styles: Record<Variant, string> = {
  default: 'border-fd-border bg-fd-secondary text-fd-secondary-foreground',
  note: 'border-fd-info/30 bg-fd-info/10 text-fd-info',
  tip: 'border-fd-idea/30 bg-fd-idea/10 text-fd-idea',
  success: 'border-fd-success/30 bg-fd-success/10 text-fd-success',
  caution: 'border-fd-warning/30 bg-fd-warning/10 text-fd-warning',
  danger: 'border-fd-error/30 bg-fd-error/10 text-fd-error',
};

/** A small inline label, such as "Done" on the roadmap. */
export function Badge({ text, variant = 'default' }: { text: string; variant?: Variant }) {
  return (
    <span
      className={`not-prose inline-flex items-center rounded-full border px-2 py-px align-middle text-xs font-medium ${styles[variant]}`}
    >
      {text}
    </span>
  );
}
