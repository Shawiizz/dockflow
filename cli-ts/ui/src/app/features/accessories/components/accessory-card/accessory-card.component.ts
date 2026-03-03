import { Component, input, output } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import type { AccessoryStatusInfo } from '@api-types';

@Component({
  selector: 'app-accessory-card',
  standalone: true,
  imports: [TagModule, TooltipModule],
  templateUrl: './accessory-card.component.html',
  styleUrl: './accessory-card.component.scss',
})
export class AccessoryCardComponent {
  accessory = input.required<AccessoryStatusInfo>();
  actionLoading = input<string | null>(null);

  restart = output<AccessoryStatusInfo>();
  stop = output<AccessoryStatusInfo>();
  viewLogs = output<AccessoryStatusInfo>();

  envEntries(env?: Record<string, string>): Array<{ key: string; value: string }> {
    if (!env) return [];
    return Object.entries(env).map(([key, value]) => ({ key, value }));
  }

  statusSeverity(status?: string): 'success' | 'danger' | 'secondary' | undefined {
    switch (status) {
      case 'running': return 'success';
      case 'stopped': return 'danger';
      default: return 'secondary';
    }
  }
}
