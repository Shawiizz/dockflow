import { Component, input, output, model, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import type { ServiceInfo } from '@api-types';

@Component({
  selector: 'app-scale-dialog',
  standalone: true,
  imports: [FormsModule, DialogModule, InputNumberModule],
  templateUrl: './scale-dialog.component.html',
  styleUrl: './scale-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScaleDialogComponent {
  visible = model(false);
  target = input<ServiceInfo | null>(null);
  loading = input(false);

  confirm = output<{ service: ServiceInfo; replicas: number }>();

  scaleValue = 1;

  onShow() {
    const t = this.target();
    if (t) this.scaleValue = t.replicas;
  }

  onConfirm() {
    const t = this.target();
    if (t) {
      this.confirm.emit({ service: t, replicas: this.scaleValue });
    }
  }
}
