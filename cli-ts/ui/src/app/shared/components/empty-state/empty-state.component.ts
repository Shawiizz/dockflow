import { Component, input, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-empty-state',
  standalone: true,
  template: `
    <div class="flex flex-col items-center justify-center gap-4 py-16 px-8 text-text-muted">
      <i [class]="icon()" class="text-5xl opacity-30"></i>
      <h3 class="m-0 text-base font-medium text-text-secondary">{{ title() }}</h3>
      @if (description()) {
        <p class="m-0 text-sm text-center max-w-[400px]">{{ description() }}</p>
      }
      <ng-content />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyStateComponent {
  icon = input.required<string>();
  title = input.required<string>();
  description = input<string>();
}
