import { Component, input } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import type { DeployHistoryEntry } from '@api-types';

@Component({
  selector: 'app-deploy-entry',
  standalone: true,
  imports: [TagModule, TooltipModule],
  templateUrl: './deploy-entry.component.html',
  styleUrl: './deploy-entry.component.scss',
})
export class DeployEntryComponent {
  deploy = input.required<DeployHistoryEntry>();

  statusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (status) {
      case 'success': return 'success';
      case 'failed': return 'danger';
      case 'running': return 'info';
      case 'pending': return 'warn';
      default: return 'secondary';
    }
  }

  statusColorClass(status: string): string {
    switch (status) {
      case 'success': return 'bg-success-muted text-success';
      case 'failed': return 'bg-error-muted text-error';
      case 'running': return 'bg-accent-muted text-accent';
      case 'pending': return 'bg-warning-muted text-warning';
      default: return 'bg-bg-tertiary text-text-muted';
    }
  }

  statusIcon(status: string): string {
    switch (status) {
      case 'success': return 'pi pi-check-circle';
      case 'failed': return 'pi pi-times-circle';
      case 'running': return 'pi pi-spin pi-spinner';
      case 'pending': return 'pi pi-clock';
      default: return 'pi pi-circle';
    }
  }

  formatDate(dateStr: string): string {
    try { return new Date(dateStr).toLocaleString(); } catch { return dateStr; }
  }

  formatDuration(seconds?: number): string {
    if (!seconds) return '\u2014';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }

  relativeTime(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diff = now.getTime() - date.getTime();
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      if (days > 0) return `${days}d ago`;
      if (hours > 0) return `${hours}h ago`;
      if (minutes > 0) return `${minutes}m ago`;
      return 'just now';
    } catch { return dateStr; }
  }
}
