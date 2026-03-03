import { Component, input, output } from '@angular/core';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import type { LockInfo } from '@api-types';

@Component({
  selector: 'app-lock-section',
  standalone: true,
  imports: [TagModule, SkeletonModule],
  templateUrl: './lock-section.component.html',
  styleUrl: './lock-section.component.scss',
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
