import { Component, input, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-page-header',
  standalone: true,
  template: `
    <div class="flex justify-between items-start gap-4 flex-wrap">
      <div class="min-w-0">
        <h1 class="m-0 text-2xl font-semibold text-text-primary truncate">{{ title() }}</h1>
        @if (subtitle()) {
          <p class="mt-1 mb-0 text-sm text-text-muted">{{ subtitle() }}</p>
        }
      </div>
      <div class="flex items-center gap-2 shrink-0 flex-wrap">
        <ng-content select="[actions]" />
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageHeaderComponent {
  title = input.required<string>();
  subtitle = input<string>();
}
