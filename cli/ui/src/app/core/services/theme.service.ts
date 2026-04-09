import { Injectable, signal, effect } from '@angular/core';

export type ThemeMode = 'dark' | 'light';

/**
 * Theme service for dark/light mode toggle.
 * Persists preference in localStorage.
 * Toggles the `.app-dark` class on <html> for PrimeNG theming.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>(this.getInitialTheme());

  readonly isDark = () => this.mode() === 'dark';

  constructor() {
    // React to theme changes
    effect(() => {
      const mode = this.mode();
      const html = document.documentElement;

      if (mode === 'dark') {
        html.classList.add('app-dark');
        html.classList.remove('app-light');
      } else {
        html.classList.remove('app-dark');
        html.classList.add('app-light');
      }

      localStorage.setItem('dockflow-theme', mode);
    });
  }

  toggle() {
    this.mode.update(m => m === 'dark' ? 'light' : 'dark');
  }

  private getInitialTheme(): ThemeMode {
    const stored = localStorage.getItem('dockflow-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    // Check system preference
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }
}
