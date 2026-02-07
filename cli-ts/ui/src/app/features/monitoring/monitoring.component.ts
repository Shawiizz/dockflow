import { Component, inject, signal, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TabsModule } from 'primeng/tabs';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import type { ContainerStatsEntry, AuditEntry } from '@api-types';

@Component({
  selector: 'app-monitoring',
  standalone: true,
  imports: [CommonModule, TabsModule, TagModule, SkeletonModule, TooltipModule],
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

  formatTime(ts: string): string {
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }

  actionSeverity(action: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (action?.toLowerCase()) {
      case 'deploy': return 'success';
      case 'rollback': return 'warn';
      case 'scale': return 'info';
      case 'stop': case 'error': return 'danger';
      default: return 'secondary';
    }
  }

  ngOnDestroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
}
