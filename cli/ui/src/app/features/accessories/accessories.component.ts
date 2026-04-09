import { Component, inject, signal, computed, DestroyRef, effect } from '@angular/core';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { DataCacheService } from '@core/services/data-cache.service';
import { pollUntilStateChange } from '@shared/utils/polling.utils';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ErrorBannerComponent } from '@shared/components/error-banner/error-banner.component';
import { EmptyStateComponent } from '@shared/components/empty-state/empty-state.component';
import { SearchFilterComponent } from '@shared/components/search-filter/search-filter.component';
import { AccessoryCardComponent } from './components/accessory-card/accessory-card.component';
import { AccessoryLogsDialogComponent } from './components/accessory-logs-dialog/accessory-logs-dialog.component';
import type { AccessoryStatusInfo, LogEntry } from '@api-types';

@Component({
  selector: 'app-accessories',
  standalone: true,
  imports: [RouterModule, FormsModule, TagModule, TooltipModule, SkeletonModule, ButtonModule, PageHeaderComponent, ErrorBannerComponent, EmptyStateComponent, SearchFilterComponent, AccessoryCardComponent, AccessoryLogsDialogComponent],
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
  searchQuery = signal('');

  filteredAccessories = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return this.accessories();
    return this.accessories().filter(acc =>
      acc.name.toLowerCase().includes(query) ||
      acc.image?.toLowerCase().includes(query) ||
      acc.status?.toLowerCase().includes(query)
    );
  });

  // Logs dialog
  logsDialogVisible = signal(false);
  logsTarget = signal('');
  logsContent = signal<LogEntry[]>([]);
  logsLoading = signal(false);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopPollingFn: (() => void) | null = null;
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
    this.stopPollingFn = pollUntilStateChange({
      items: this.accessories,
      findItem: (items) => items.find(a => a.name === accName),
      getState: (item) => item?.status,
      actionLoading: this.actionLoading,
      invalidateCache: () => this.cache.invalidatePrefix('accessories-status:'),
      reload: () => this.loadAccessories(env, { silent: true }),
    });
  }

  private stopPolling() {
    if (this.stopPollingFn) {
      this.stopPollingFn();
      this.stopPollingFn = null;
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
}
