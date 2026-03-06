import { Component, input, ChangeDetectionStrategy } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import type { DeployHistoryEntry } from '@api-types';
import { deployStatusSeverity, deployStatusIcon, deployStatusColorClass } from '@shared/utils/status.utils';
import { FormatTimePipe } from '@shared/utils/format-time.pipe';

@Component({
  selector: 'app-deploy-entry',
  standalone: true,
  imports: [TagModule, TooltipModule, FormatTimePipe],
  templateUrl: './deploy-entry.component.html',
  styleUrl: './deploy-entry.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeployEntryComponent {
  deploy = input.required<DeployHistoryEntry>();

  statusSeverity = deployStatusSeverity;
  statusColorClass = deployStatusColorClass;
  statusIcon = deployStatusIcon;

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
