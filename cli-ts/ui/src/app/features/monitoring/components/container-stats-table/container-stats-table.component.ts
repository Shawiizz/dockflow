import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import type { ContainerStatsEntry } from '@api-types';
import { FormatTimePipe } from '@shared/utils/format-time.pipe';
import { ErrorBannerComponent } from '@shared/components/error-banner/error-banner.component';
import { EmptyStateComponent } from '@shared/components/empty-state/empty-state.component';

@Component({
  selector: 'app-container-stats-table',
  standalone: true,
  imports: [SkeletonModule, ButtonModule, FormatTimePipe, ErrorBannerComponent, EmptyStateComponent],
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
