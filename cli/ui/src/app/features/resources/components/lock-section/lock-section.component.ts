import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import type { LockInfo } from '@api-types';
import { ErrorBannerComponent } from '@shared/components/error-banner/error-banner.component';

@Component({
  selector: 'app-lock-section',
  standalone: true,
  imports: [TagModule, SkeletonModule, ButtonModule, ErrorBannerComponent],
  templateUrl: './lock-section.component.html',
  styleUrl: './lock-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LockSectionComponent {
  lockInfo = input<LockInfo>({ locked: false });
  loading = input(false);
  error = input<string | null>(null);
  actioning = input(false);

  refresh = output<void>();
  acquire = output<void>();
  release = output<void>();
}
