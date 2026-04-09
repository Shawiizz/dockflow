import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of, catchError } from 'rxjs';
import { ApiService } from './api.service';
import type { ServerStatus } from '@api-types';

@Injectable({ providedIn: 'root' })
export class ServerStatusService {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  readonly servers = signal<ServerStatus[]>([]);
  readonly environments = signal<string[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly checkingServers = signal<Set<string>>(new Set());

  readonly onlineCount = computed(() =>
    this.servers().filter(s => s.status === 'online').length,
  );
  readonly offlineCount = computed(() =>
    this.servers().filter(s => s.status === 'offline' || s.status === 'error').length,
  );

  private loadedEnv: string | null = null;

  /** Load server list. Skips fetch if same env already loaded. */
  loadServers(env?: string) {
    const key = env ?? '';
    if (this.loadedEnv === key) return;

    this.loading.set(true);
    this.error.set(null);

    this.apiService.getServers(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          this.servers.set(response.servers);
          this.environments.set(response.environments);
          this.loading.set(false);
          this.loadedEnv = key;
          this.checkAll();
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(err?.error?.error || 'Failed to load servers');
        },
      });
  }

  checkStatus(name: string) {
    this.checkingServers.update(s => new Set(s).add(name));
    this.apiService.getServerStatus(name)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => of({ name, status: 'error' as const, error: 'Connection failed' } as ServerStatus)),
      )
      .subscribe(status => {
        this.servers.update(list =>
          list.map(s => s.name === name ? { ...s, ...status } : s),
        );
        this.checkingServers.update(s => {
          const next = new Set(s);
          next.delete(name);
          return next;
        });
      });
  }

  checkAll() {
    for (const server of this.servers()) {
      this.checkStatus(server.name);
    }
  }

  isChecking(name: string) {
    return this.checkingServers().has(name);
  }

  reload(env?: string) {
    this.loadedEnv = null;
    this.loadServers(env);
  }
}
