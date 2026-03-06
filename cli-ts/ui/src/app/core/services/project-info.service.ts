import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { ApiService } from './api.service';
import type { ProjectInfo, ConnectionInfo } from '@api-types';

@Injectable({ providedIn: 'root' })
export class ProjectInfoService {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  readonly projectInfo = signal<ProjectInfo | null>(null);
  readonly connectionInfo = signal<ConnectionInfo | null>(null);
  readonly loadingProject = signal(true);
  readonly loadingConnection = signal(true);
  readonly refreshing = signal(false);

  private loaded = false;

  load() {
    if (this.loaded) return;
    this.fetchAll(false);
  }

  reload() {
    this.fetchAll(true);
  }

  private fetchAll(isReload: boolean) {
    if (isReload) {
      this.refreshing.set(true);
    } else {
      this.loadingProject.set(true);
      this.loadingConnection.set(true);
    }

    forkJoin([
      this.apiService.getProjectInfo(),
      this.apiService.getConnectionInfo(),
    ]).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ([project, connection]) => {
        this.projectInfo.set(project);
        this.connectionInfo.set(connection);
        this.loadingProject.set(false);
        this.loadingConnection.set(false);
        this.refreshing.set(false);
        this.loaded = true;
      },
      error: () => {
        this.loadingProject.set(false);
        this.loadingConnection.set(false);
        this.refreshing.set(false);
      },
    });
  }
}
