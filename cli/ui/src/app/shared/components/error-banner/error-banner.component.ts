import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';

@Component({
  selector: 'app-error-banner',
  standalone: true,
  imports: [ButtonModule, MessageModule],
  template: `
    <p-message severity="error" [closable]="false">
      <div class="flex items-center gap-2 w-full">
        <span class="text-sm flex-1">{{ message() }}</span>
        <p-button
          icon="pi pi-refresh"
          severity="danger"
          [text]="true"
          [rounded]="true"
          size="small"
          (onClick)="retry.emit()"
          ariaLabel="Retry"
        />
      </div>
    </p-message>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErrorBannerComponent {
  message = input.required<string>();
  retry = output<void>();
}
