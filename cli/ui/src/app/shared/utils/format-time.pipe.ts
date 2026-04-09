import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'formatTime', standalone: true })
export class FormatTimePipe implements PipeTransform {
  transform(ts: string, format: 'time' | 'datetime' = 'datetime'): string {
    try {
      const date = new Date(ts);
      return format === 'time' ? date.toLocaleTimeString() : date.toLocaleString();
    } catch {
      return ts;
    }
  }
}
