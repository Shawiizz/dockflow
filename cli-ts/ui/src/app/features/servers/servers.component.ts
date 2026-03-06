import { Component, inject, signal, computed, DestroyRef, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { EnvironmentService } from '@core/services/environment.service';
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
    FormsModule,
    SelectModule,
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
  private destroyRef = inject(DestroyRef);

  envService = inject(EnvironmentService);
  serverStatus = inject(ServerStatusService);

  // SSH terminal state
  sshVisible = signal(false);
  sshServerName = signal('');
  sshServerHost = signal('');

  // Pre-computed set for O(1) lookup in template
  checkingSet = computed(() => this.serverStatus.checkingServers());

  constructor() {
    effect(() => {
      const env = this.envService.selected();
      // Don't load with empty env while environments are still loading
      // to avoid a wasted request that gets overwritten when the real env arrives
      if (!env && this.envService.loading()) return;
      this.serverStatus.loadServers(env || undefined);
    });
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
