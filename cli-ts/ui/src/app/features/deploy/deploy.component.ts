import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { TimelineModule } from 'primeng/timeline';
import { ApiService } from '@core/services/api.service';
import type { DeployHistoryEntry } from '@api-types';

@Component({
  selector: 'app-deploy',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SelectModule,
    TagModule,
    TooltipModule,
    SkeletonModule,
    TimelineModule,
  ],
  templateUrl: './deploy.component.html',
  styleUrl: './deploy.component.scss',
})
export class DeployComponent implements OnInit {
  private apiService = inject(ApiService);

  loading = signal(true);
  deployments = signal<DeployHistoryEntry[]>([]);
  environments = signal<string[]>([]);
  selectedEnv = signal<string>('');

  envOptions = computed(() => [
    { label: 'All environments', value: '' },
    ...this.environments().map((e) => ({ label: e, value: e })),
  ]);

  ngOnInit() {
    this.loadEnvironments();
    this.loadHistory();
  }

  loadEnvironments() {
    this.apiService.getEnvironments().subscribe({
      next: (envs) => this.environments.set(envs),
    });
  }

  loadHistory() {
    this.loading.set(true);
    const env = this.selectedEnv() || undefined;
    this.apiService.getDeployHistory(env).subscribe({
      next: (response) => {
        this.deployments.set(response.deployments);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  onEnvChange() {
    this.loadHistory();
  }

  statusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (status) {
      case 'success': return 'success';
      case 'failed': return 'danger';
      case 'running': return 'info';
      case 'pending': return 'warn';
      default: return 'secondary';
    }
  }

  statusIcon(status: string): string {
    switch (status) {
      case 'success': return 'pi pi-check-circle';
      case 'failed': return 'pi pi-times-circle';
      case 'running': return 'pi pi-spin pi-spinner';
      case 'pending': return 'pi pi-clock';
      default: return 'pi pi-circle';
    }
  }

  formatDate(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  }

  formatDuration(seconds?: number): string {
    if (!seconds) return '—';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }

  relativeTime(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diff = now.getTime() - date.getTime();
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (days > 0) return `${days}d ago`;
      if (hours > 0) return `${hours}h ago`;
      if (minutes > 0) return `${minutes}m ago`;
      return 'just now';
    } catch {
      return dateStr;
    }
  }
}
