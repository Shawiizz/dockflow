import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ButtonModule } from 'primeng/button';
import type { AccessoryStatusInfo } from '@api-types';
import { serviceStateSeverity } from '@shared/utils/status.utils';

@Component({
  selector: 'app-accessory-card',
  standalone: true,
  imports: [TagModule, TooltipModule, ButtonModule],
  templateUrl: './accessory-card.component.html',
  styleUrl: './accessory-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  statusSeverity = serviceStateSeverity;
}
