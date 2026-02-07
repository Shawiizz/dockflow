import { Component, inject, signal, computed, OnInit, DestroyRef, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { DataCacheService } from '@core/services/data-cache.service';
import type { ServiceInfo } from '@api-types';

@Component({
  selector: 'app-services',
  standalone: true,
  imports: [CommonModule, RouterModule, TagModule, TooltipModule, SkeletonModule],
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

  runningCount = computed(() => this.services().filter(s => s.state === 'running').length);
  stoppedCount = computed(() => this.services().filter(s => s.state !== 'running').length);

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      this.loadServices(env || undefined);
    });
  }

  ngOnInit() {}

  loadServices(env?: string) {
    const cacheKey = `services:${env || 'all'}`;
    const cached = this.cache.get<{ services: ServiceInfo[]; stackName: string }>(cacheKey);
    if (cached) {
      this.services.set(cached.services);
      this.stackName.set(cached.stackName);
      this.loading.set(false);
      this.error.set(null);
      return;
    }

    this.loading.set(true);
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
}
