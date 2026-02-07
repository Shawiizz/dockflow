import { Component, inject, signal, computed, OnInit, OnDestroy, DestroyRef, effect, viewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import type { ServiceInfo, LogEntry } from '@api-types';

@Component({
  selector: 'app-logs',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, ToggleSwitchModule, SkeletonModule, TooltipModule],
  templateUrl: './logs.component.html',
  styleUrl: './logs.component.scss',
})
export class LogsComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);

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

  logViewer = viewChild<ElementRef<HTMLDivElement>>('logViewer');

  tailOptions = [
    { label: '50 lines', value: 50 },
    { label: '100 lines', value: 100 },
    { label: '200 lines', value: 200 },
    { label: '500 lines', value: 500 },
  ];

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
        this.autoRefreshTimer = setInterval(() => this.loadLogs(), 5000);
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
    this.apiService.getServices(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.services.set(response.services);
          this.loadingServices.set(false);
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
    const viewer = this.logViewer()?.nativeElement;
    if (viewer) {
      viewer.scrollTop = viewer.scrollHeight;
    }
  }

  formatTimestamp(ts: string): string {
    try {
      const date = new Date(ts);
      return date.toLocaleTimeString();
    } catch {
      return ts;
    }
  }
}
