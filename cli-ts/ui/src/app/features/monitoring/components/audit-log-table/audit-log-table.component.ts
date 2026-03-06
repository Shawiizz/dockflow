import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import type { AuditEntry } from '@api-types';
import { auditActionSeverity } from '@shared/utils/status.utils';
import { FormatTimePipe } from '@shared/utils/format-time.pipe';

@Component({
  selector: 'app-audit-log-table',
  standalone: true,
  imports: [TagModule, TooltipModule, SkeletonModule, FormatTimePipe],
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
