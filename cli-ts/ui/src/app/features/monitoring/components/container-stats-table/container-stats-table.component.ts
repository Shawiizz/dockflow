import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { NgClass } from '@angular/common';
import { SkeletonModule } from 'primeng/skeleton';
import type { ContainerStatsEntry } from '@api-types';
import { FormatTimePipe } from '@shared/utils/format-time.pipe';

@Component({
  selector: 'app-container-stats-table',
  standalone: true,
  imports: [NgClass, SkeletonModule, FormatTimePipe],
  templateUrl: './container-stats-table.component.html',
  styleUrl: './container-stats-table.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerStatsTableComponent {
  containers = input<ContainerStatsEntry[]>([]);
  loading = input(false);
  error = input<string | null>(null);
  timestamp = input('');
  autoRefresh = input(false);

  refresh = output<void>();
  toggleAutoRefresh = output<void>();
}
