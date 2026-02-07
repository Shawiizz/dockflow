import { Component, inject, signal, computed, OnInit, DestroyRef, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { ServerStatusService } from '@core/services/server-status.service';
import { StatsCardComponent } from './components/stats-card/stats-card.component';
import { ServerCardComponent } from './components/server-card/server-card.component';
import { WelcomeCardComponent } from './components/welcome-card/welcome-card.component';
import { SshTerminalComponent } from '@shared/components/ssh-terminal/ssh-terminal.component';
import type { ProjectInfo, ConnectionInfo } from '@api-types';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    SkeletonModule,
    StatsCardComponent,
    ServerCardComponent,
    WelcomeCardComponent,
    SshTerminalComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit {
  private apiService = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  envService = inject(EnvironmentService);
  serverStatus = inject(ServerStatusService);

  projectInfo = signal<ProjectInfo | null>(null);
  connectionInfo = signal<ConnectionInfo | null>(null);
  loadingProject = signal(true);
  errorMessage = signal<string | null>(null);

  // SSH terminal state
  sshVisible = signal(false);
  sshServerName = signal('');
  sshServerHost = signal('');

  totalServers = computed(() => this.serverStatus.servers().length);
  envCount = computed(() => this.serverStatus.environments().length);

  constructor() {
    // Reload servers when environment changes
    effect(() => {
      const env = this.envService.selected();
      this.serverStatus.loadServers(env || undefined);
    });
  }

  ngOnInit() {
    this.loadProjectInfo();
    this.loadConnectionInfo();
  }

  private loadProjectInfo() {
    this.loadingProject.set(true);
    this.apiService.getProjectInfo()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (info) => {
          this.projectInfo.set(info);
          this.loadingProject.set(false);
        },
        error: (err) => {
          this.loadingProject.set(false);
          this.errorMessage.set(err?.error?.error || 'Failed to load project info');
        },
      });
  }

  private loadConnectionInfo() {
    this.apiService.getConnectionInfo()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (info) => this.connectionInfo.set(info),
        error: () => {},
      });
  }

  onCheckServer(serverName: string) {
    this.serverStatus.checkStatus(serverName);
  }

  openSsh(server: { name: string; host: string }) {
    this.sshServerName.set(server.name);
    this.sshServerHost.set(server.host);
    this.sshVisible.set(true);
  }
}
