import { Component, inject, signal, computed, OnInit, OnDestroy, DestroyRef, effect, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { DataCacheService } from '@core/services/data-cache.service';
import { VisibilityService } from '@core/services/visibility.service';
import type { ServiceInfo, LogEntry } from '@api-types';
import { LogControlsComponent } from './components/log-controls/log-controls.component';
import { LogViewerComponent } from './components/log-viewer/log-viewer.component';

@Component({
  selector: 'app-logs',
  standalone: true,
  imports: [SkeletonModule, TooltipModule, LogControlsComponent, LogViewerComponent],
  templateUrl: './logs.component.html',
  styleUrl: './logs.component.scss',
})
export class LogsComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);
  private cache = inject(DataCacheService);
  private visibility = inject(VisibilityService);

  envService = inject(EnvironmentService);

  loading = signal(false);
  loadingServices = signal(true);
  services = signal<ServiceInfo[]>([]);
  selectedService = signal('');
  logs = signal<LogEntry[]>([]);
  error = signal<string | null>(null);
  servicesError = signal<string | null>(null);

  tailLines = signal(100);
  autoScroll = signal(true);
  autoRefresh = signal(false);

  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  logViewer = viewChild(LogViewerComponent);

  serviceOptions = computed(() =>
    this.services().map(s => ({ label: s.name, value: s.name })),
  );

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      this.loadServiceList(env || undefined);
    });

    // Auto-refresh effect
    effect(() => {
      const enabled = this.autoRefresh();
      this.clearAutoRefresh();
      if (enabled && this.selectedService()) {
        this.autoRefreshTimer = setInterval(() => {
          // Skip polling when tab is hidden
          if (!this.visibility.visible()) return;
          this.loadLogs();
        }, 5000);
      }
    });
  }

  ngOnInit() {
    // Check for service query param
    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      if (params['service']) {
        this.selectedService.set(params['service']);
        this.loadLogs();
      }
    });
  }

  ngOnDestroy() {
    this.clearAutoRefresh();
  }

  private clearAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  loadServiceList(env?: string) {
    this.loadingServices.set(true);
    this.servicesError.set(null);

    const cacheKey = `logs-services:${env || 'all'}`;
    const cached = this.cache.get<ServiceInfo[]>(cacheKey);
    if (cached) {
      this.services.set(cached);
      this.loadingServices.set(false);
      if (cached.length > 0 && !this.selectedService()) {
        this.selectedService.set(cached[0].name);
        this.loadLogs();
      }
      return;
    }

    this.apiService.getServices(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.services.set(response.services);
          this.loadingServices.set(false);
          this.cache.set(cacheKey, response.services, 60_000);
          if (response.services.length === 0 && response.message) {
            this.servicesError.set(response.message);
          }
          if (response.services.length > 0 && !this.selectedService()) {
            this.selectedService.set(response.services[0].name);
            this.loadLogs();
          }
        },
        error: (err) => {
          this.loadingServices.set(false);
          this.servicesError.set(err?.error?.error || 'Failed to load services');
        },
      });
  }

  onServiceChange() {
    this.loadLogs();
  }

  onTailChange() {
    this.loadLogs();
  }

  loadLogs() {
    const service = this.selectedService();
    if (!service) return;

    this.loading.set(true);
    this.error.set(null);
    const env = this.envService.selectedOrUndefined();

    this.apiService.getServiceLogs(service, this.tailLines(), env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.logs.set(response.logs);
          this.loading.set(false);
          if (this.autoScroll()) {
            setTimeout(() => this.scrollToBottom(), 50);
          }
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(err?.error?.error || 'Failed to load logs');
        },
      });
  }

  private scrollToBottom() {
    this.logViewer()?.scrollToBottom();
  }
}
