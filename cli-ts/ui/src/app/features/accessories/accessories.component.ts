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

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      this.loadAccessories(env || undefined);
    });
  }

  loadAccessories(env?: string) {
    const cacheKey = `accessories-status:${env || 'all'}`;
    const cached = this.cache.get<AccessoryStatusInfo[]>(cacheKey);
    if (cached) {
      this.accessories.set(cached);
      this.loading.set(false);
      this.error.set(null);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    this.apiService.getAccessoriesStatus(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.accessories.set(response.accessories);
          this.loading.set(false);
          if (response.message && response.accessories.length === 0) {
            this.error.set(response.message);
          }
          this.cache.set(cacheKey, response.accessories, 60_000);
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(err?.error?.error || 'Failed to load accessories');
        },
      });
  }

  refresh() {
    this.cache.invalidatePrefix('accessories-status:');
    this.loadAccessories(this.envService.selectedOrUndefined());
  }

  onRestart(acc: AccessoryStatusInfo) {
    this.actionLoading.set(acc.name);
    this.apiService.restartAccessory(acc.name, this.envService.selectedOrUndefined())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.cache.invalidatePrefix('accessories-status:');
          this.loadAccessories(this.envService.selectedOrUndefined());
        },
        error: (err) => {
          this.error.set(err?.error?.error || 'Failed to restart accessory');
        },
        complete: () => this.actionLoading.set(null),
      });
  }

  onStop(acc: AccessoryStatusInfo) {
    this.actionLoading.set(acc.name);
    this.apiService.stopAccessory(acc.name, this.envService.selectedOrUndefined())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.cache.invalidatePrefix('accessories-status:');
          this.loadAccessories(this.envService.selectedOrUndefined());
        },
        error: (err) => {
          this.error.set(err?.error?.error || 'Failed to stop accessory');
        },
        complete: () => this.actionLoading.set(null),
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
