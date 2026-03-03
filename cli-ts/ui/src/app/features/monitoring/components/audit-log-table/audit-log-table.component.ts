import { Component, input, output } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import type { AuditEntry } from '@api-types';

@Component({
  selector: 'app-audit-log-table',
  standalone: true,
  imports: [TagModule, TooltipModule, SkeletonModule],
  templateUrl: './audit-log-table.component.html',
  styleUrl: './audit-log-table.component.scss',
})
export class AuditLogTableComponent {
  entries = input<AuditEntry[]>([]);
  loading = input(false);
  error = input<string | null>(null);

  refresh = output<void>();

  formatTime(ts: string): string {
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }

  actionSeverity(action: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (action?.toLowerCase()) {
      case 'deploy': return 'success';
      case 'rollback': return 'warn';
      case 'scale': return 'info';
      case 'stop': case 'error': return 'danger';
      default: return 'secondary';
    }
  }
}
