import { Component, input, viewChild, ElementRef } from '@angular/core';
import type { LogEntry } from '@api-types';

@Component({
  selector: 'app-log-viewer',
  standalone: true,
  imports: [],
  templateUrl: './log-viewer.component.html',
  styleUrl: './log-viewer.component.scss',
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

  formatTimestamp(ts: string): string {
    try { return new Date(ts).toLocaleTimeString(); } catch { return ts; }
  }
}
