import { Component, inject, signal, DestroyRef, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { DialogModule } from 'primeng/dialog';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { DataCacheService } from '@core/services/data-cache.service';
import type { AccessoryStatusInfo, LogEntry } from '@api-types';

@Component({
  selector: 'app-accessories',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, TagModule, TooltipModule, SkeletonModule, DialogModule],
  templateUrl: './accessories.component.html',
  styleUrl: './accessories.component.scss',
})
export class AccessoriesComponent {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private cache = inject(DataCacheService);

  envService = inject(EnvironmentService);

  loading = signal(true);
  accessories = signal<AccessoryStatusInfo[]>([]);
  error = signal<string | null>(null);
  actionLoading = signal<string | null>(null);

  // Logs dialog
  logsDialogVisible = signal(false);
  logsTarget = signal('');
  logsContent = signal<LogEntry[]>([]);
  logsLoading = signal(false);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private loadVersion = 0;

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      this.loadAccessories(env || undefined);
    });
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  loadAccessories(env?: string, opts?: { silent?: boolean }) {
    const cacheKey = `accessories-status:${env || 'all'}`;
    if (!opts?.silent) {
      const cached = this.cache.get<AccessoryStatusInfo[]>(cacheKey);
      if (cached) {
        this.accessories.set(cached);
        this.loading.set(false);
        this.error.set(null);
        return;
      }
      this.loading.set(true);
    }
    this.error.set(null);
    const version = ++this.loadVersion;
    this.apiService.getAccessoriesStatus(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (version !== this.loadVersion) return;
          this.accessories.set(response.accessories);
          this.loading.set(false);
          if (response.message && response.accessories.length === 0) {
            this.error.set(response.message);
          }
          this.cache.set(cacheKey, response.accessories, 60_000);
        },
        error: (err) => {
          if (version !== this.loadVersion) return;
          this.loading.set(false);
          this.error.set(err?.error?.error || 'Failed to load accessories');
        },
      });
  }

  refresh() {
    this.actionLoading.set(null);
    this.stopPolling();
    this.cache.invalidatePrefix('accessories-status:');
    this.loadAccessories(this.envService.selectedOrUndefined());
  }

  private handleActionResult(res: { success: boolean; message: string }, accName: string, env?: string) {
    if (!res.success) {
      this.actionLoading.set(null);
      this.error.set(res.message);
      return;
    }
    this.refreshAfterAction(accName, env);
  }

  private refreshAfterAction(accName: string, env?: string) {
    this.stopPolling();
    const initialStatus = this.accessories().find(a => a.name === accName)?.status;
    let elapsed = 0;
    this.pollTimer = setInterval(() => {
      elapsed += 3000;
      const currentStatus = this.accessories().find(a => a.name === accName)?.status;
      if (currentStatus !== initialStatus) {
        this.actionLoading.set(null);
        this.stopPolling();
        return;
      }
      if (elapsed >= 45_000) {
        this.actionLoading.set(null);
        this.stopPolling();
        return;
      }
      this.cache.invalidatePrefix('accessories-status:');
      this.loadAccessories(env, { silent: true });
    }, 3000);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  onRestart(acc: AccessoryStatusInfo) {
    this.actionLoading.set(acc.name);
    this.apiService.restartAccessory(acc.name, this.envService.selectedOrUndefined())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.handleActionResult(res, acc.name, this.envService.selectedOrUndefined()),
        error: (err) => {
          this.actionLoading.set(null);
          this.error.set(err?.error?.error || 'Failed to restart accessory');
        },
      });
  }

  onStop(acc: AccessoryStatusInfo) {
    this.actionLoading.set(acc.name);
    this.apiService.stopAccessory(acc.name, this.envService.selectedOrUndefined())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.handleActionResult(res, acc.name, this.envService.selectedOrUndefined()),
        error: (err) => {
          this.actionLoading.set(null);
          this.error.set(err?.error?.error || 'Failed to stop accessory');
        },
      });
  }

  onViewLogs(acc: AccessoryStatusInfo) {
    this.logsTarget.set(acc.name);
    this.logsContent.set([]);
    this.logsLoading.set(true);
    this.logsDialogVisible.set(true);
    this.apiService.getAccessoryLogs(acc.name, 100, this.envService.selectedOrUndefined())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.logsContent.set(res.logs);
          this.logsLoading.set(false);
        },
        error: () => {
          this.logsLoading.set(false);
        },
      });
  }

  envEntries(env?: Record<string, string>): Array<{ key: string; value: string }> {
    if (!env) return [];
    return Object.entries(env).map(([key, value]) => ({ key, value }));
  }

  statusSeverity(status?: string): 'success' | 'danger' | 'secondary' | undefined {
    switch (status) {
      case 'running': return 'success';
      case 'stopped': return 'danger';
      default: return 'secondary';
    }
  }
}
