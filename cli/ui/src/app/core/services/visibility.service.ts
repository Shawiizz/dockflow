import { Injectable, signal, DestroyRef, inject } from '@angular/core';

/**
 * Tracks browser tab visibility using the Page Visibility API.
 * Polling components should check `visible()` before firing requests
 * to avoid wasting bandwidth and battery when the tab is hidden.
 */
@Injectable({ providedIn: 'root' })
export class VisibilityService {
  private destroyRef = inject(DestroyRef);

  readonly visible = signal(!document.hidden);

  constructor() {
    const handler = () => this.visible.set(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', handler));
  }
}
