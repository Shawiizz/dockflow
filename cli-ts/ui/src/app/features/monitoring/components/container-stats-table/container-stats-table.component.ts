import { Component, input, output } from '@angular/core';
import { NgClass } from '@angular/common';
import { SkeletonModule } from 'primeng/skeleton';

import type { ContainerStatsEntry } from '@api-types';

@Component({
  selector: 'app-container-stats-table',
  standalone: true,
  imports: [NgClass, SkeletonModule],
  templateUrl: './container-stats-table.component.html',
  styleUrl: './container-stats-table.component.scss',
})
export class ContainerStatsTableComponent {
  containers = input<ContainerStatsEntry[]>([]);
  loading = input(false);
  error = input<string | null>(null);
  timestamp = input('');
  autoRefresh = input(false);

  refresh = output<void>();
  toggleAutoRefresh = output<void>();

  formatTime(ts: string): string {
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }
}
