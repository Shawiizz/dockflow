import { Component, input, model, ChangeDetectionStrategy } from '@angular/core';
import { DialogModule } from 'primeng/dialog';
import { SkeletonModule } from 'primeng/skeleton';
import type { LogEntry } from '@api-types';

@Component({
  selector: 'app-accessory-logs-dialog',
  standalone: true,
  imports: [DialogModule, SkeletonModule],
  templateUrl: './accessory-logs-dialog.component.html',
  styleUrl: './accessory-logs-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccessoryLogsDialogComponent {
  visible = model(false);
  target = input('');
  logs = input<LogEntry[]>([]);
  loading = input(false);
}
