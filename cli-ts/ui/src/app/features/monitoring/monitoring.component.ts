import { Component, inject, signal, OnDestroy, effect } from '@angular/core';
import { TabsModule } from 'primeng/tabs';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
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

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      this.loadStats(env || undefined);
      this.loadAudit(env || undefined);
    });
  }

  loadStats(env?: string) {
    this.statsLoading.set(true);
    this.statsError.set(null);
    this.apiService.getContainerStats(env).subscribe({
      next: (res) => {
        this.containers.set(res.containers);
        this.statsTimestamp.set(res.timestamp);
        this.statsLoading.set(false);
      },
      error: (err) => {
        this.statsLoading.set(false);
        this.statsError.set(err?.error?.error || 'Failed to load stats');
      },
    });
  }

  loadAudit(env?: string) {
    this.auditLoading.set(true);
    this.auditError.set(null);
    this.apiService.getAuditLog(100, env).subscribe({
      next: (res) => {
        this.auditEntries.set(res.entries);
        this.auditLoading.set(false);
      },
      error: (err) => {
        this.auditLoading.set(false);
        this.auditError.set(err?.error?.error || 'Failed to load audit log');
      },
    });
  }

  toggleAutoRefresh() {
    this.autoRefresh.update(v => !v);
    if (this.autoRefresh()) {
      this.refreshInterval = setInterval(() => {
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
