import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from './api.service';

/**
 * Global environment state shared across all components.
 * Changing the environment here automatically affects all pages.
 */
@Injectable({ providedIn: 'root' })
export class EnvironmentService {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  /** All available environments */
  readonly environments = signal<string[]>([]);

  /** Currently selected environment (empty = default/all) */
  readonly selected = signal<string>('');

  /** Loading state */
  readonly loading = signal(true);

  /** Options for PrimeNG Select (with "All" entry) */
  readonly allOptions = computed(() => [
    { label: 'All environments', value: '' },
    ...this.environments().map(e => ({ label: e, value: e })),
  ]);

  /** Options without the "All" entry */
  readonly envOptions = computed(() => [
    { label: 'Default', value: '' },
    ...this.environments().map(e => ({ label: e, value: e })),
  ]);

  /** Whether environments have been loaded at least once */
  private loaded = false;

  load() {
    if (this.loaded) return;
    this.loading.set(true);
    this.apiService.getEnvironments()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: envs => {
          this.environments.set(envs);
          if (envs.length > 0 && !this.selected()) {
            this.selected.set(envs[0]);
          }
          this.loading.set(false);
          this.loaded = true;
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }

  /** Force reload environments */
  reload() {
    this.loaded = false;
    this.load();
  }

  /** Selected env value for API calls (undefined if empty) */
  readonly selectedOrUndefined = computed(() => this.selected() || undefined);
}
