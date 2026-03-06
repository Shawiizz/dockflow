import { Component, inject, signal, computed, DestroyRef, effect } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SkeletonModule } from 'primeng/skeleton';
import { EnvironmentService } from '@core/services/environment.service';
import { ProjectInfoService } from '@core/services/project-info.service';
import { ServerStatusService } from '@core/services/server-status.service';
import { StatsCardComponent } from './components/stats-card/stats-card.component';
import { ServerCardComponent } from './components/server-card/server-card.component';
import { WelcomeCardComponent } from './components/welcome-card/welcome-card.component';
import { SshTerminalComponent } from '@shared/components/ssh-terminal/ssh-terminal.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
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
export class DashboardComponent {
  envService = inject(EnvironmentService);
  projectInfoService = inject(ProjectInfoService);
  serverStatus = inject(ServerStatusService);

  // SSH terminal state
  sshVisible = signal(false);
  sshServerName = signal('');
  sshServerHost = signal('');

  totalServers = computed(() => this.serverStatus.servers().length);
  envCount = computed(() => this.serverStatus.environments().length);

  showWelcome = computed(() => {
    const info = this.projectInfoService.projectInfo();
    return !this.projectInfoService.loadingProject() && info && !info.hasDockflow;
  });

  constructor() {
    // Reload servers when environment changes
    effect(() => {
      const env = this.envService.selected();
      // Don't load with empty env while environments are still loading
      // to avoid a wasted request that gets overwritten when the real env arrives
      if (!env && this.envService.loading()) return;
      this.serverStatus.loadServers(env || undefined);
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
