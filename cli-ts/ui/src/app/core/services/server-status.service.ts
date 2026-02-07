import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, mergeMap, of, catchError } from 'rxjs';
import { ApiService } from './api.service';
import { DataCacheService } from './data-cache.service';
import type { ServerStatus } from '@api-types';

/**
 * Centralized server status management.
 * Shared across Dashboard and Servers pages.
 * Handles status checking with concurrency control.
 */
@Injectable({ providedIn: 'root' })
export class ServerStatusService {
  private apiService = inject(ApiService);
  private cache = inject(DataCacheService);
  private destroyRef = inject(DestroyRef);

  /** All servers */
  readonly servers = signal<ServerStatus[]>([]);

  /** Set of server names currently being checked */
  readonly checkingServers = signal<Set<string>>(new Set());

  /** Available environments from servers response */
  readonly environments = signal<string[]>([]);

  /** Loading state */
  readonly loading = signal(true);

  /** Error message */
  readonly error = signal<string | null>(null);

  /** Computed counts */
  readonly onlineCount = computed(() =>
    this.servers().filter(s => s.status === 'online').length,
  );
  readonly offlineCount = computed(() =>
    this.servers().filter(s => s.status === 'offline' || s.status === 'error').length,
  );
  readonly unknownCount = computed(() =>
    this.servers().filter(s => s.status === 'unknown').length,
  );

  /** Subject for queuing status checks with concurrency control */
  private checkQueue$ = new Subject<string>();

  constructor() {
    // Process status checks with max 4 concurrent requests
    this.checkQueue$.pipe(
      mergeMap(name => this.apiService.getServerStatus(name).pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => of({ name, status: 'error', error: 'Connection failed' } as ServerStatus)),
      ), 4),
    ).subscribe(status => {
      this.servers.update(servers =>
        servers.map(s => s.name === status.name ? { ...s, ...status } : s),
      );
      this.removeChecking(status.name);
    });
  }

  /** Load servers list, using cache if available */
  loadServers(env?: string) {
    const cacheKey = `servers:${env || 'all'}`;
    const cached = this.cache.get<{ servers: ServerStatus[]; environments: string[] }>(cacheKey);

    if (cached) {
      this.servers.set(cached.servers);
      this.environments.set(cached.environments);
      this.loading.set(false);
      this.error.set(null);
      this.checkAll();
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    this.apiService.getServers(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          this.servers.set(response.servers);
          this.environments.set(response.environments);
          this.loading.set(false);
          this.cache.set(cacheKey, {
            servers: response.servers,
            environments: response.environments,
          }, 60_000); // 1 minute cache
          this.checkAll();
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(err?.error?.error || 'Failed to load servers');
        },
      });
  }

  /** Check status for a single server */
  checkStatus(serverName: string) {
    this.checkingServers.update(set => new Set(set).add(serverName));
    // Individual check doesn't go through mergeMap to avoid losing error context
    this.apiService.getServerStatus(serverName)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: status => {
          this.servers.update(servers =>
            servers.map(s => s.name === serverName ? status : s),
          );
          this.removeChecking(serverName);
        },
        error: () => {
          this.servers.update(servers =>
            servers.map(s =>
              s.name === serverName
                ? { ...s, status: 'error' as const, error: 'Connection failed' }
                : s,
            ),
          );
          this.removeChecking(serverName);
        },
      });
  }

  /** Check all servers with concurrency control */
  checkAll() {
    for (const server of this.servers()) {
      this.checkingServers.update(set => new Set(set).add(server.name));
      this.checkQueue$.next(server.name);
    }
  }

  /** Check if a server is being checked */
  isChecking(name: string): boolean {
    return this.checkingServers().has(name);
  }

  /** Force reload (invalidate cache) */
  reload(env?: string) {
    this.cache.invalidate(`servers:${env || 'all'}`);
    this.loadServers(env);
  }

  private removeChecking(name: string) {
    this.checkingServers.update(set => {
      const next = new Set(set);
      next.delete(name);
      return next;
    });
  }
}
