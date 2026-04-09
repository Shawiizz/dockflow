import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import type { AuditEntry } from '@api-types';
import { auditActionSeverity } from '@shared/utils/status.utils';
import { FormatTimePipe } from '@shared/utils/format-time.pipe';
import { ErrorBannerComponent } from '@shared/components/error-banner/error-banner.component';
import { EmptyStateComponent } from '@shared/components/empty-state/empty-state.component';

@Component({
  selector: 'app-audit-log-table',
  standalone: true,
  imports: [TagModule, TooltipModule, SkeletonModule, ButtonModule, FormatTimePipe, ErrorBannerComponent, EmptyStateComponent],
  templateUrl: './audit-log-table.component.html',
  styleUrl: './audit-log-table.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuditLogTableComponent {
  entries = input<AuditEntry[]>([]);
  loading = input(false);
  error = input<string | null>(null);

  refresh = output<void>();

  actionSeverity = auditActionSeverity;
}
