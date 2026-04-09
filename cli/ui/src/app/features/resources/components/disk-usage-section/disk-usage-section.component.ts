import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { ErrorBannerComponent } from '@shared/components/error-banner/error-banner.component';

@Component({
  selector: 'app-disk-usage-section',
  standalone: true,
  imports: [SkeletonModule, ButtonModule, ErrorBannerComponent],
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
