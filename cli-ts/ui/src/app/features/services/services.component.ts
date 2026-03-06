import { Component, inject, signal, computed, DestroyRef, effect } from '@angular/core';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { ConfirmPopupModule } from 'primeng/confirmpopup';
import { ConfirmationService } from 'primeng/api';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { DataCacheService } from '@core/services/data-cache.service';
import { pollUntilStateChange } from '@shared/utils/polling.utils';
import { SshTerminalComponent } from '@shared/components/ssh-terminal/ssh-terminal.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { EmptyStateComponent } from '@shared/components/empty-state/empty-state.component';
import { ErrorBannerComponent } from '@shared/components/error-banner/error-banner.component';
import { SearchFilterComponent } from '@shared/components/search-filter/search-filter.component';
import { ServiceCardComponent } from './components/service-card/service-card.component';
import { ScaleDialogComponent } from './components/scale-dialog/scale-dialog.component';
import type { ServiceInfo } from '@api-types';

@Component({
  selector: 'app-services',
  standalone: true,
  imports: [
    RouterModule,
    FormsModule,
    TagModule,
    TooltipModule,
    SkeletonModule,
    ButtonModule,
    ConfirmPopupModule,
    SshTerminalComponent,
    PageHeaderComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
    SearchFilterComponent,
    ServiceCardComponent,
    ScaleDialogComponent,
  ],
  providers: [ConfirmationService],
  templateUrl: './services.component.html',
  styleUrl: './services.component.scss',
})
export class ServicesComponent {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private cache = inject(DataCacheService);
  private confirmationService = inject(ConfirmationService);

  envService = inject(EnvironmentService);

  loading = signal(true);
  services = signal<ServiceInfo[]>([]);
  stackName = signal('');
  error = signal<string | null>(null);

  actionLoading = signal<string | null>(null);
  scaleDialogVisible = signal(false);
  scaleTarget = signal<ServiceInfo | null>(null);
  terminalVisible = signal(false);
  terminalService = signal<ServiceInfo | null>(null);
  searchQuery = signal('');
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopPollingFn: (() => void) | null = null;
  private loadVersion = 0;

  runningCount = computed(() => this.services().filter(s => s.state === 'running').length);
  stoppedCount = computed(() => this.services().filter(s => s.state !== 'running').length);
  filteredServices = computed(() => {
    const query = this.searchQuery().toLowerCase();
    if (!query) return this.services();
    return this.services().filter(s => s.name.toLowerCase().includes(query));
  });

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      this.loadServices(env || undefined);
    });
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  loadServices(env?: string, opts?: { silent?: boolean }) {
    const cacheKey = `services:${env || 'all'}`;
    if (!opts?.silent) {
      const cached = this.cache.get<{ services: ServiceInfo[]; stackName: string }>(cacheKey);
      if (cached) {
        this.services.set(cached.services);
        this.stackName.set(cached.stackName);
        this.loading.set(false);
        this.error.set(null);
        return;
      }
      this.loading.set(true);
    }
    this.error.set(null);
    const version = ++this.loadVersion;
    this.apiService.getServices(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (version !== this.loadVersion) return;
          this.services.set(response.services);
          this.stackName.set(response.stackName);
          this.loading.set(false);
          if (response.message && response.services.length === 0) {
            this.error.set(response.message);
          }
          this.cache.set(cacheKey, { services: response.services, stackName: response.stackName }, 60_000);
        },
        error: (err) => {
          if (version !== this.loadVersion) return;
          this.loading.set(false);
          this.error.set(err?.error?.error || 'Failed to load services');
        },
      });
  }

  refresh() {
    this.actionLoading.set(null);
    this.stopPolling();
    this.cache.invalidatePrefix('services:');
    this.loadServices(this.envService.selectedOrUndefined());
  }

  private refreshAfterAction(serviceName: string, env?: string) {
    this.stopPolling();
    this.stopPollingFn = pollUntilStateChange({
      items: this.services,
      findItem: (items) => items.find(s => s.name === serviceName),
      getState: (item) => item?.state,
      actionLoading: this.actionLoading,
      invalidateCache: () => this.cache.invalidatePrefix('services:'),
      reload: () => this.loadServices(env, { silent: true }),
    });
  }

  private stopPolling() {
    if (this.stopPollingFn) {
      this.stopPollingFn();
      this.stopPollingFn = null;
    }
  }

  // ── Service Actions ─────────────────────────────────────────────────────

  private handleActionResult(res: { success: boolean; message: string }, serviceName: string, env?: string) {
    if (!res.success) {
      this.actionLoading.set(null);
      this.error.set(res.message);
      return;
    }
    this.refreshAfterAction(serviceName, env);
  }

  onRestart(service: ServiceInfo) {
    const env = this.envService.selectedOrUndefined();
    this.actionLoading.set(service.name);
    this.apiService.restartService(service.name, env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.handleActionResult(res, service.name, env),
        error: (err) => {
          this.actionLoading.set(null);
          this.error.set(err?.error?.error || `Failed to restart ${service.name}`);
        },
      });
  }

  onStop(service: ServiceInfo) {
    const env = this.envService.selectedOrUndefined();
    this.actionLoading.set(service.name);
    this.apiService.stopService(service.name, env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.handleActionResult(res, service.name, env),
        error: (err) => {
          this.actionLoading.set(null);
          this.error.set(err?.error?.error || `Failed to stop ${service.name}`);
        },
      });
  }

  onStart(service: ServiceInfo) {
    const env = this.envService.selectedOrUndefined();
    this.actionLoading.set(service.name);
    this.apiService.scaleService(service.name, 1, env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.handleActionResult(res, service.name, env),
        error: (err) => {
          this.actionLoading.set(null);
          this.error.set(err?.error?.error || `Failed to start ${service.name}`);
        },
      });
  }

  onScale(service: ServiceInfo) {
    this.scaleTarget.set(service);
    this.scaleDialogVisible.set(true);
  }

  confirmScale(event: { service: ServiceInfo; replicas: number }) {
    const target = event.service;
    const env = this.envService.selectedOrUndefined();
    this.actionLoading.set(target.name);
    this.scaleDialogVisible.set(false);
    this.apiService.scaleService(target.name, event.replicas, env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.scaleTarget.set(null);
          this.handleActionResult(res, target.name, env);
        },
        error: (err) => {
          this.actionLoading.set(null);
          this.scaleTarget.set(null);
          this.error.set(err?.error?.error || `Failed to scale ${target.name}`);
        },
      });
  }

  onRollback(service: ServiceInfo) {
    const env = this.envService.selectedOrUndefined();
    this.actionLoading.set(service.name);
    this.apiService.rollbackService(service.name, env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.handleActionResult(res, service.name, env),
        error: (err) => {
          this.actionLoading.set(null);
          this.error.set(err?.error?.error || `Failed to rollback ${service.name}`);
        },
      });
  }

  requestConfirm(type: string, { event, service }: { event: Event; service: ServiceInfo }) {
    const isStopping = type === 'stop';
    this.confirmationService.confirm({
      target: event.currentTarget as EventTarget,
      message: `Are you sure you want to ${type} ${service.name}?`,
      icon: isStopping ? 'pi pi-exclamation-triangle' : 'pi pi-info-circle',
      rejectButtonProps: {
        label: 'Cancel',
        severity: 'secondary',
        outlined: true,
      },
      acceptButtonProps: {
        label: type.charAt(0).toUpperCase() + type.slice(1),
        severity: isStopping ? 'danger' : 'warn',
      },
      accept: () => {
        switch (type) {
          case 'restart':
            this.onRestart(service);
            break;
          case 'stop':
            this.onStop(service);
            break;
          case 'rollback':
            this.onRollback(service);
            break;
        }
      },
    });
  }

  onExec(service: ServiceInfo) {
    this.terminalService.set(service);
    this.terminalVisible.set(true);
  }
}
