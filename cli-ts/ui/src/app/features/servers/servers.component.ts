import { Component, inject, signal, computed, OnInit, DestroyRef, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { EnvironmentService } from '@core/services/environment.service';
import { ServerStatusService } from '@core/services/server-status.service';
import { SshTerminalComponent } from '@shared/components/ssh-terminal/ssh-terminal.component';

@Component({
  selector: 'app-servers',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SelectModule,
    TableModule,
    TagModule,
    TooltipModule,
    SkeletonModule,
    SshTerminalComponent,
  ],
  templateUrl: './servers.component.html',
  styleUrl: './servers.component.scss',
})
export class ServersComponent implements OnInit {
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
      this.serverStatus.loadServers(env || undefined);
    });
  }

  ngOnInit() {
    // Servers are loaded reactively via the effect
  }

  onEnvChange() {
    // Handled by the effect watching envService.selected()
  }

  roleSeverity(role: string): 'info' | 'secondary' | 'warn' | 'success' | 'danger' | 'contrast' | undefined {
    return role === 'manager' ? 'info' : 'secondary';
  }

  statusLabel(status: string): string {
    switch (status) {
      case 'online': return 'Online';
      case 'offline': return 'Offline';
      case 'error': return 'Error';
      default: return 'Unknown';
    }
  }

  statusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (status) {
      case 'online': return 'success';
      case 'offline': return 'danger';
      case 'error': return 'danger';
      default: return 'secondary';
    }
  }

  statusIcon(status: string): string {
    switch (status) {
      case 'online': return 'pi pi-check-circle';
      case 'offline': return 'pi pi-times-circle';
      case 'error': return 'pi pi-exclamation-triangle';
      default: return 'pi pi-question-circle';
    }
  }

  swarmSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (status) {
      case 'leader': return 'success';
      case 'reachable': return 'info';
      case 'unreachable': return 'danger';
      default: return 'secondary';
    }
  }

  openSsh(server: { name: string; host: string }) {
    this.sshServerName.set(server.name);
    this.sshServerHost.set(server.host);
    this.sshVisible.set(true);
  }
}
