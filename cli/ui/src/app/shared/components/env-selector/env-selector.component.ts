import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { EnvironmentService } from '@core/services/environment.service';

/**
 * Per-page environment picker. Every page that targets a single SSH connection
 * (deploy, logs, restart…) embeds this instead of relying on a global selector —
 * there's no "All environments" option here, the underlying action always needs
 * one real environment.
 */
@Component({
  selector: 'app-env-selector',
  standalone: true,
  imports: [FormsModule, SelectModule, SkeletonModule],
  template: `
    @if (envService.loading()) {
      <p-skeleton width="8rem" height="1.75rem" />
    } @else if (envService.environments().length > 0) {
      <p-select
        [options]="envService.envOptions()"
        [ngModel]="envService.selected()"
        (ngModelChange)="envService.selected.set($event)"
        optionLabel="label"
        optionValue="value"
        placeholder="Environment"
        size="small"
        class="min-w-36"
      />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnvSelectorComponent {
  envService = inject(EnvironmentService);
}
