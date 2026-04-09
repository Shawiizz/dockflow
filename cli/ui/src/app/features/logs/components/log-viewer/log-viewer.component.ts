import { Component, input, viewChild, ElementRef, ChangeDetectionStrategy } from '@angular/core';
import type { LogEntry } from '@api-types';
import { FormatTimePipe } from '@shared/utils/format-time.pipe';

@Component({
  selector: 'app-log-viewer',
  standalone: true,
  imports: [FormatTimePipe],
  templateUrl: './log-viewer.component.html',
  styleUrl: './log-viewer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogViewerComponent {
  logs = input<LogEntry[]>([]);
  loading = input(false);
  selectedService = input('');

  viewer = viewChild<ElementRef<HTMLDivElement>>('logViewer');

  scrollToBottom() {
    const el = this.viewer()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
