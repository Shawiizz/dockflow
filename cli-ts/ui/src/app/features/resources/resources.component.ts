import { Component, inject, signal, effect } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import type { PruneResult, LockInfo } from '@api-types';
import { PruneSectionComponent } from './components/prune-section/prune-section.component';
import { LockSectionComponent } from './components/lock-section/lock-section.component';
import { DiskUsageSectionComponent } from './components/disk-usage-section/disk-usage-section.component';

@Component({
  selector: 'app-resources',
  standalone: true,
  imports: [TagModule, SkeletonModule, PruneSectionComponent, LockSectionComponent, DiskUsageSectionComponent],
  templateUrl: './resources.component.html',
  styleUrl: './resources.component.scss',
})
export class ResourcesComponent {
  private apiService = inject(ApiService);
  envService = inject(EnvironmentService);

  // Prune
  pruning = signal(false);
  pruneResults = signal<PruneResult[]>([]);

  // Lock
  lockLoading = signal(true);
  lockInfo = signal<LockInfo>({ locked: false });
  lockError = signal<string | null>(null);
  lockActioning = signal(false);

  // Disk usage
  diskLoading = signal(true);
  diskRaw = signal('');
  diskError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      if (env) {
        this.loadLock(env);
        this.loadDisk(env);
      }
    });
  }

  // ── Prune ──

  runPrune(event: { targets: string[]; all: boolean }) {
    this.pruning.set(true);
    this.pruneResults.set([]);
    this.apiService.pruneResources(
      { targets: event.targets as any, all: event.all },
      this.envService.selectedOrUndefined()
    ).subscribe({
      next: (res) => {
        this.pruneResults.set(res.results);
        this.pruning.set(false);
      },
      error: () => {
        this.pruning.set(false);
      },
    });
  }

  // ── Lock ──

  loadLock(env: string) {
    this.lockLoading.set(true);
    this.lockError.set(null);
    this.apiService.getLockStatus(env).subscribe({
      next: (info) => {
        this.lockInfo.set(info);
        this.lockLoading.set(false);
      },
      error: (err) => {
        this.lockLoading.set(false);
        this.lockError.set(err?.error?.error || 'Failed to get lock status');
      },
    });
  }

  acquireLock() {
    const env = this.envService.selectedOrUndefined();
    if (!env) return;
    this.lockActioning.set(true);
    this.apiService.acquireLock(env).subscribe({
      next: () => {
        this.loadLock(env);
        this.lockActioning.set(false);
      },
      error: () => this.lockActioning.set(false),
    });
  }

  releaseLock() {
    const env = this.envService.selectedOrUndefined();
    if (!env) return;
    this.lockActioning.set(true);
    this.apiService.releaseLock(env).subscribe({
      next: () => {
        this.loadLock(env);
        this.lockActioning.set(false);
      },
      error: () => this.lockActioning.set(false),
    });
  }

  refreshLock() {
    const env = this.envService.selectedOrUndefined();
    if (env) this.loadLock(env);
  }

  // ── Disk ──

  loadDisk(env: string) {
    this.diskLoading.set(true);
    this.diskError.set(null);
    this.apiService.getDiskUsage(env).subscribe({
      next: (res) => {
        this.diskRaw.set(res.raw);
        this.diskLoading.set(false);
      },
      error: (err) => {
        this.diskLoading.set(false);
        this.diskError.set(err?.error?.error || 'Failed to get disk usage');
      },
    });
  }

  refreshDisk() {
    const env = this.envService.selectedOrUndefined();
    if (env) this.loadDisk(env);
  }
}
