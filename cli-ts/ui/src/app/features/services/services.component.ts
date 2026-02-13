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
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private loadVersion = 0;

  runningCount = computed(() => this.services().filter(s => s.state === 'running').length);
  stoppedCount = computed(() => this.services().filter(s => s.state !== 'running').length);

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      this.loadServices(env || undefined);
    });
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  ngOnInit() {}

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
    const initialState = this.services().find(s => s.name === serviceName)?.state;
    // Docker applies changes async, poll every 3s until state changes (up to 45s)
    let elapsed = 0;
    this.pollTimer = setInterval(() => {
      elapsed += 3000;
      const currentState = this.services().find(s => s.name === serviceName)?.state;
      if (currentState !== initialState) {
        this.actionLoading.set(null);
        this.stopPolling();
        return;
      }
      if (elapsed >= 45_000) {
        this.actionLoading.set(null);
        this.stopPolling();
        return;
      }
      this.cache.invalidatePrefix('services:');
      this.loadServices(env, { silent: true });
    }, 3000);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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

  onExec(service: ServiceInfo) {
    this.terminalService.set(service);
    this.terminalVisible.set(true);
  }
}
