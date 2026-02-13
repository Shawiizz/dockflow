import { Component, inject, signal, computed, OnInit, DestroyRef, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { DataCacheService } from '@core/services/data-cache.service';
import { SshTerminalComponent } from '@shared/components/ssh-terminal/ssh-terminal.component';
import type { ServiceInfo } from '@api-types';

@Component({
  selector: 'app-services',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, TagModule, TooltipModule, SkeletonModule, DialogModule, InputNumberModule, SshTerminalComponent],
  templateUrl: './services.component.html',
  styleUrl: './services.component.scss',
})
export class ServicesComponent implements OnInit {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private cache = inject(DataCacheService);

  envService = inject(EnvironmentService);

  loading = signal(true);
  services = signal<ServiceInfo[]>([]);
  stackName = signal('');
  error = signal<string | null>(null);

  actionLoading = signal<string | null>(null);
  scaleDialogVisible = signal(false);
  scaleTarget = signal<ServiceInfo | null>(null);
  scaleValueNum = 1;
  terminalVisible = signal(false);
  terminalService = signal<ServiceInfo | null>(null);

  runningCount = computed(() => this.services().filter(s => s.state === 'running').length);
  stoppedCount = computed(() => this.services().filter(s => s.state !== 'running').length);

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      this.loadServices(env || undefined);
    });
  }

  ngOnInit() {}

  loadServices(env?: string, opts?: { silent?: boolean }) {
    const cacheKey = `services:${env || 'all'}`;
    const cached = this.cache.get<{ services: ServiceInfo[]; stackName: string }>(cacheKey);
    if (cached) {
      this.services.set(cached.services);
      this.stackName.set(cached.stackName);
      this.loading.set(false);
      this.error.set(null);
      return;
    }

    if (!opts?.silent) {
      this.loading.set(true);
    }
    this.error.set(null);
    this.apiService.getServices(env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.services.set(response.services);
          this.stackName.set(response.stackName);
          this.loading.set(false);
          if (response.message && response.services.length === 0) {
            this.error.set(response.message);
          }
          this.cache.set(cacheKey, { services: response.services, stackName: response.stackName }, 60_000);
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(err?.error?.error || 'Failed to load services');
        },
      });
  }

  refresh() {
    this.cache.invalidatePrefix('services:');
    this.loadServices(this.envService.selectedOrUndefined());
  }

  replicaPercent(service: ServiceInfo): number {
    if (service.replicas === 0) return 0;
    return (service.replicasRunning / service.replicas) * 100;
  }

  replicaFillClass(service: ServiceInfo): string {
    const pct = this.replicaPercent(service);
    if (pct >= 100) return 'service-card__replicas-fill--full';
    if (pct > 0) return 'service-card__replicas-fill--partial';
    return 'service-card__replicas-fill--zero';
  }

  stateSeverity(state: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (state) {
      case 'running': return 'success';
      case 'stopped': return 'danger';
      case 'paused': return 'warn';
      case 'error': return 'danger';
      default: return 'secondary';
    }
  }

  // ── Service Actions ─────────────────────────────────────────────────────

  onRestart(service: ServiceInfo) {
    const env = this.envService.selectedOrUndefined();
    this.actionLoading.set(service.name);
    this.apiService.restartService(service.name, env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.actionLoading.set(null);
          this.cache.invalidatePrefix('services:');
          this.loadServices(env, { silent: true });
        },
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
        next: () => {
          this.actionLoading.set(null);
          this.cache.invalidatePrefix('services:');
          this.loadServices(env, { silent: true });
        },
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
        next: () => {
          this.actionLoading.set(null);
          this.cache.invalidatePrefix('services:');
          this.loadServices(env, { silent: true });
        },
        error: (err) => {
          this.actionLoading.set(null);
          this.error.set(err?.error?.error || `Failed to start ${service.name}`);
        },
      });
  }

  onScale(service: ServiceInfo) {
    this.scaleTarget.set(service);
    this.scaleValueNum = service.replicas;
    this.scaleDialogVisible.set(true);
  }

  confirmScale() {
    const target = this.scaleTarget();
    if (!target) return;
    const env = this.envService.selectedOrUndefined();
    this.actionLoading.set(target.name);
    this.scaleDialogVisible.set(false);
    this.apiService.scaleService(target.name, this.scaleValueNum, env)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.actionLoading.set(null);
          this.scaleTarget.set(null);
          this.cache.invalidatePrefix('services:');
          this.loadServices(env, { silent: true });
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
        next: () => {
          this.actionLoading.set(null);
          this.cache.invalidatePrefix('services:');
          this.loadServices(env, { silent: true });
        },
        error: (err) => {
          this.actionLoading.set(null);
          this.error.set(err?.error?.error || `Failed to rollback ${service.name}`);
        },
      });
  }

  onExec(service: ServiceInfo) {
    this.terminalService.set(service);
    this.terminalVisible.set(true);
  }
}
