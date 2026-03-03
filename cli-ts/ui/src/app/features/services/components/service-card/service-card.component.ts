import { Component, input, output, computed } from '@angular/core';
import { RouterModule } from '@angular/router';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import type { ServiceInfo } from '@api-types';

@Component({
  selector: 'app-service-card',
  standalone: true,
  imports: [RouterModule, TagModule, TooltipModule],
  templateUrl: './service-card.component.html',
  styleUrl: './service-card.component.scss',
})
export class ServiceCardComponent {
  service = input.required<ServiceInfo>();
  actionLoading = input<string | null>(null);

  restart = output<ServiceInfo>();
  stop = output<ServiceInfo>();
  start = output<ServiceInfo>();
  scale = output<ServiceInfo>();
  rollback = output<ServiceInfo>();
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

  stateSeverity(state: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (state) {
      case 'running': return 'success';
      case 'stopped': return 'danger';
      case 'paused': return 'warn';
      case 'error': return 'danger';
      default: return 'secondary';
    }
  }
}
