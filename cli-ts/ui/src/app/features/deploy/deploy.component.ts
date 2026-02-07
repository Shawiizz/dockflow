import { Component, inject, signal, computed, OnInit, DestroyRef, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { DataCacheService } from '@core/services/data-cache.service';
import type { DeployHistoryEntry } from '@api-types';

@Component({
  selector: 'app-deploy',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, TagModule, TooltipModule, SkeletonModule],
  templateUrl: './deploy.component.html',
  styleUrl: './deploy.component.scss',
})
export class DeployComponent implements OnInit {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private cache = inject(DataCacheService);

  envService = inject(EnvironmentService);

  loading = signal(true);
  deployments = signal<DeployHistoryEntry[]>([]);
  error = signal<string | null>(null);

  // Deploy form
  showForm = signal(false);
  deploying = signal(false);
  deployLogs = signal<string[]>([]);
  deploySuccess = signal<boolean | null>(null);

  version = '';
  skipBuild = false;
  force = false;
  deployAccessories = false;
  all = false;
  skipAccessories = false;
  servicesFilter = '';
  dryRun = false;

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      this.loadHistory(env || undefined);
    });
  }

  ngOnInit() {}

  loadHistory(env?: string) {
    const cacheKey = `deploy:${env || 'all'}`;
    const cached = this.cache.get<DeployHistoryEntry[]>(cacheKey);
    if (cached) {
      this.deployments.set(cached);
      this.loading.set(false);
      this.error.set(null);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    this.apiService.getDeployHistory(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.deployments.set(response.deployments);
          this.loading.set(false);
          this.cache.set(cacheKey, response.deployments, 60_000);
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(err?.error?.error || 'Failed to load deploy history');
        },
      });
  }

  refresh() {
    this.cache.invalidatePrefix('deploy:');
    this.loadHistory(this.envService.selectedOrUndefined());
  }

  startDeploy() {
    const env = this.envService.selectedOrUndefined();
    if (!env) return;

    this.deploying.set(true);
    this.deployLogs.set([]);
    this.deploySuccess.set(null);

    const body: Record<string, unknown> = { environment: env };
    if (this.version.trim()) body['version'] = this.version.trim();
    if (this.skipBuild) body['skipBuild'] = true;
    if (this.force) body['force'] = true;
    if (this.deployAccessories) body['accessories'] = true;
    if (this.all) body['all'] = true;
    if (this.skipAccessories) body['skipAccessories'] = true;
    if (this.servicesFilter.trim()) body['services'] = this.servicesFilter.trim();
    if (this.dryRun) body['dryRun'] = true;

    fetch('/api/operations/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((response) => {
        if (!response.ok || !response.body) {
          this.deployLogs.update(l => [...l, `Error: ${response.statusText}`]);
          this.deploying.set(false);
          this.deploySuccess.set(false);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const readChunk = (): void => {
          reader.read().then(({ done, value }) => {
            if (done) {
              this.deploying.set(false);
              if (this.deploySuccess() === null) this.deploySuccess.set(true);
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';
            for (const part of parts) {
              const eventMatch = part.match(/^event:\s*(.+)$/m);
              const dataMatch = part.match(/^data:\s*(.+)$/m);
              if (!dataMatch) continue;
              try {
                const data = JSON.parse(dataMatch[1]);
                const eventType = eventMatch ? eventMatch[1] : 'log';
                if (eventType === 'log') {
                  this.deployLogs.update(l => [...l, data.line]);
                } else if (eventType === 'done') {
                  this.deploySuccess.set(data.success);
                  this.deploying.set(false);
                }
              } catch { /* ignore */ }
            }
            readChunk();
          });
        };
        readChunk();
      })
      .catch((err) => {
        this.deployLogs.update(l => [...l, `Error: ${err.message}`]);
        this.deploying.set(false);
        this.deploySuccess.set(false);
      });
  }

  cancelDeploy() {
    this.apiService.cancelOperation().subscribe();
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
    if (!seconds) return '\u2014';
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
