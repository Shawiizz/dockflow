import type { ReactNode } from 'react';

/**
 * Numbered steps: wraps an ordered Markdown list and draws each item as a step,
 * with its number in a circle and a line down to the next one (styles in app/global.css).
 */
export function Steps({ children }: { children: ReactNode }) {
  return <div className="df-steps">{children}</div>;
}
