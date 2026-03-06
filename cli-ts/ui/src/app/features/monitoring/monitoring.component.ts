import { Component, inject, signal, OnDestroy, effect, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { TabsModule } from 'primeng/tabs';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { VisibilityService } from '@core/services/visibility.service';
import type { ContainerStatsEntry, AuditEntry } from '@api-types';
import { ContainerStatsTableComponent } from './components/container-stats-table/container-stats-table.component';
import { AuditLogTableComponent } from './components/audit-log-table/audit-log-table.component';

@Component({
  selector: 'app-monitoring',
  standalone: true,
  imports: [TabsModule, SkeletonModule, ContainerStatsTableComponent, AuditLogTableComponent],
  templateUrl: './monitoring.component.html',
  styleUrl: './monitoring.component.scss',
})
export class MonitoringComponent implements OnDestroy {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private visibility = inject(VisibilityService);
  envService = inject(EnvironmentService);

  // Container stats
  statsLoading = signal(true);
  containers = signal<ContainerStatsEntry[]>([]);
  statsTimestamp = signal('');
  statsError = signal<string | null>(null);
  autoRefresh = signal(false);
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  // Audit log
  auditLoading = signal(true);
  auditEntries = signal<AuditEntry[]>([]);
  auditError = signal<string | null>(null);

  activeTab = signal(0);

  // Subscription tracking for cancellation on re-call
  private statsSubscription: Subscription | null = null;
  private auditSubscription: Subscription | null = null;

  constructor() {
    // Only load data for the active tab when env or tab changes
    effect(() => {
      const env = this.envService.selected();
      const tab = this.activeTab();
      if (tab === 0) {
        this.loadStats(env || undefined);
      } else {
        this.loadAudit(env || undefined);
      }
    });
  }

  loadStats(env?: string) {
    this.statsSubscription?.unsubscribe();
    this.statsLoading.set(true);
    this.statsError.set(null);
    this.statsSubscription = this.apiService.getContainerStats(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.statsSubscription = null;
          this.containers.set(res.containers);
          this.statsTimestamp.set(res.timestamp);
          this.statsLoading.set(false);
        },
        error: (err) => {
          this.statsSubscription = null;
          this.statsLoading.set(false);
          this.statsError.set(err?.error?.error || 'Failed to load stats');
        },
      });
  }

  loadAudit(env?: string) {
    this.auditSubscription?.unsubscribe();
    this.auditLoading.set(true);
    this.auditError.set(null);
    this.auditSubscription = this.apiService.getAuditLog(100, env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.auditSubscription = null;
          this.auditEntries.set(res.entries);
          this.auditLoading.set(false);
        },
        error: (err) => {
          this.auditSubscription = null;
          this.auditLoading.set(false);
          this.auditError.set(err?.error?.error || 'Failed to load audit log');
        },
      });
  }

  toggleAutoRefresh() {
    this.autoRefresh.update(v => !v);
    if (this.autoRefresh()) {
      this.refreshInterval = setInterval(() => {
        // Skip polling when tab is hidden
        if (!this.visibility.visible()) return;
        this.loadStats(this.envService.selectedOrUndefined());
      }, 10000);
    } else if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  refreshStats() {
    this.loadStats(this.envService.selectedOrUndefined());
  }

  refreshAudit() {
    this.loadAudit(this.envService.selectedOrUndefined());
  }

  ngOnDestroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
}
