import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { SkeletonModule } from 'primeng/skeleton';

@Component({
  selector: 'app-disk-usage-section',
  standalone: true,
  imports: [SkeletonModule],
  templateUrl: './disk-usage-section.component.html',
  styleUrl: './disk-usage-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiskUsageSectionComponent {
  raw = input('');
  loading = input(false);
  error = input<string | null>(null);

  refresh = output<void>();
}
