import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { NgClass } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';
import type { ServerStatus } from '@api-types';
import { serverStatusIcon, serverStatusLabel } from '@shared/utils/status.utils';

@Component({
  selector: 'app-server-card',
  standalone: true,
  imports: [NgClass, TooltipModule],
  templateUrl: './server-card.component.html',
  styleUrl: './server-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  statusIcon = () => serverStatusIcon(this.server().status);

  statusLabel = () => {
    if (this.checkingStatus()) return 'Checking...';
    return serverStatusLabel(this.server().status);
  };
}
