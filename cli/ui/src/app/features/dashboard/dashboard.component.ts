import { Component, inject, signal, computed } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { ProjectInfoService } from '@core/services/project-info.service';
import { ServerStatusService } from '@core/services/server-status.service';
import { StatsCardComponent } from './components/stats-card/stats-card.component';
import { ServerCardComponent } from './components/server-card/server-card.component';
import { WelcomeCardComponent } from './components/welcome-card/welcome-card.component';
import { SshTerminalComponent } from '@shared/components/ssh-terminal/ssh-terminal.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { EmptyStateComponent } from '@shared/components/empty-state/empty-state.component';

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
    PageHeaderComponent,
    EmptyStateComponent,
    ButtonModule,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
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
    // Servers is a config read, not an SSH target — always show every environment.
    this.serverStatus.loadServers();
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
