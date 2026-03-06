import { Component, inject, signal, DestroyRef, effect, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { ButtonModule } from 'primeng/button';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { DataCacheService } from '@core/services/data-cache.service';
import { OperationStateService } from '@core/services/operation-state.service';
import { DeployEntryComponent } from './components/deploy-entry/deploy-entry.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { EmptyStateComponent } from '@shared/components/empty-state/empty-state.component';
import { ErrorBannerComponent } from '@shared/components/error-banner/error-banner.component';
import type { DeployHistoryEntry } from '@api-types';

@Component({
  selector: 'app-deploy',
  standalone: true,
  imports: [FormsModule, SelectModule, TagModule, TooltipModule, SkeletonModule, InputTextModule, CheckboxModule, ButtonModule, DeployEntryComponent, PageHeaderComponent, EmptyStateComponent, ErrorBannerComponent],
  templateUrl: './deploy.component.html',
  styleUrl: './deploy.component.scss',
})
export class DeployComponent {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private cache = inject(DataCacheService);
  private opState = inject(OperationStateService);

  envService = inject(EnvironmentService);

  loading = signal(true);
  deployments = signal<DeployHistoryEntry[]>([]);
  error = signal<string | null>(null);

  // Deploy form — delegate to OperationStateService
  showForm = signal(false);
  deploying = this.opState.deploying;
  deployLogs = this.opState.deployLogs;
  deploySuccess = this.opState.deploySuccess;

  private outputEl = viewChild<ElementRef>('outputContainer');

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
    effect(() => {
      this.deployLogs();
      const el = this.outputEl()?.nativeElement;
      if (el) {
        requestAnimationFrame(() => el.scrollTop = el.scrollHeight);
      }
    });
  }

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

    const body: Record<string, unknown> = { environment: env };
    if (this.version.trim()) body['version'] = this.version.trim();
    if (this.skipBuild) body['skipBuild'] = true;
    if (this.force) body['force'] = true;
    if (this.deployAccessories) body['accessories'] = true;
    if (this.all) body['all'] = true;
    if (this.skipAccessories) body['skipAccessories'] = true;
    if (this.servicesFilter.trim()) body['services'] = this.servicesFilter.trim();
    if (this.dryRun) body['dryRun'] = true;

    this.opState.startDeploy(body);
  }

  cancelDeploy() {
    this.opState.cancelDeploy();
  }
}
