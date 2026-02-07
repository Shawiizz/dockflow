import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';
import type { ServerStatus } from '@api-types';

@Component({
  selector: 'app-server-card',
  standalone: true,
  imports: [CommonModule, TooltipModule],
  templateUrl: './server-card.component.html',
  styleUrl: './server-card.component.scss',
})
export class ServerCardComponent {
  server = input.required<ServerStatus>();
  checkingStatus = input(false);
  checkStatus = output<void>();
  sshOpen = output<void>();

  statusClass = () => {
    if (this.checkingStatus()) return 'checking';
    return this.server().status;
  };

  statusIcon = () => {
    const status = this.server().status;
    switch (status) {
      case 'online': return 'pi pi-check';
      case 'offline': return 'pi pi-times';
      case 'error': return 'pi pi-exclamation-triangle';
      default: return 'pi pi-question';
    }
  };

  statusLabel = () => {
    if (this.checkingStatus()) return 'Checking...';
    const status = this.server().status;
    switch (status) {
      case 'online': return 'Online';
      case 'offline': return 'Offline';
      case 'error': return 'Error';
      default: return 'Unknown';
    }
  };
}
