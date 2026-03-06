import { Component, input, output, computed, ChangeDetectionStrategy } from '@angular/core';
import { RouterModule } from '@angular/router';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ButtonModule } from 'primeng/button';
import type { ServiceInfo } from '@api-types';
import { serviceStateSeverity } from '@shared/utils/status.utils';

@Component({
  selector: 'app-service-card',
  standalone: true,
  imports: [RouterModule, TagModule, TooltipModule, ButtonModule],
  templateUrl: './service-card.component.html',
  styleUrl: './service-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServiceCardComponent {
  service = input.required<ServiceInfo>();
  actionLoading = input<string | null>(null);

  restart = output<{ event: Event; service: ServiceInfo }>();
  stop = output<{ event: Event; service: ServiceInfo }>();
  start = output<ServiceInfo>();
  scale = output<ServiceInfo>();
  rollback = output<{ event: Event; service: ServiceInfo }>();
  exec = output<ServiceInfo>();
  viewLogs = output<ServiceInfo>();

  replicaPercent = computed(() => {
    const svc = this.service();
    if (svc.replicas === 0) return 0;
    return (svc.replicasRunning / svc.replicas) * 100;
  });

  replicaFillClass = computed(() => {
    const pct = this.replicaPercent();
    if (pct >= 100) return 'bg-success';
    if (pct > 0) return 'bg-warning';
    return 'bg-error';
  });

  stateSeverity = serviceStateSeverity;
}
