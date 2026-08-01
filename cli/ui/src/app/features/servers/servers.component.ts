import { Component, inject, signal, computed } from '@angular/core';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { ServerStatusService } from '@core/services/server-status.service';
import { SshTerminalComponent } from '@shared/components/ssh-terminal/ssh-terminal.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { EmptyStateComponent } from '@shared/components/empty-state/empty-state.component';
import { ErrorBannerComponent } from '@shared/components/error-banner/error-banner.component';
import { serverStatusSeverity, serverStatusLabel, serverStatusIcon, swarmSeverity, roleSeverity } from '@shared/utils/status.utils';

@Component({
  selector: 'app-servers',
  standalone: true,
  imports: [
    TableModule,
    TagModule,
    TooltipModule,
    SkeletonModule,
    ButtonModule,
    SshTerminalComponent,
    PageHeaderComponent,
    EmptyStateComponent,
    ErrorBannerComponent,
  ],
  templateUrl: './servers.component.html',
  styleUrl: './servers.component.scss',
})
export class ServersComponent {
  serverStatus = inject(ServerStatusService);

  // SSH terminal state
  sshVisible = signal(false);
  sshServerName = signal('');
  sshServerHost = signal('');

  // Pre-computed set for O(1) lookup in template
  checkingSet = computed(() => this.serverStatus.checkingServers());

  constructor() {
    // Servers is a config read, not an SSH target — always show every environment.
    this.serverStatus.loadServers();
  }

  roleSeverity = roleSeverity;
  statusLabel = serverStatusLabel;
  statusSeverity = serverStatusSeverity;
  statusIcon = serverStatusIcon;
  swarmSeverity = swarmSeverity;

  openSsh(server: { name: string; host: string }) {
    this.sshServerName.set(server.name);
    this.sshServerHost.set(server.host);
    this.sshVisible.set(true);
  }
}
