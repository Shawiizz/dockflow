import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SkeletonModule } from 'primeng/skeleton';

@Component({
  selector: 'app-log-controls',
  standalone: true,
  imports: [FormsModule, SelectModule, ToggleSwitchModule, SkeletonModule],
  templateUrl: './log-controls.component.html',
  styleUrl: './log-controls.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogControlsComponent {
  serviceOptions = input<{ label: string; value: string }[]>([]);
  selectedService = input('');
  tailLines = input(100);
  autoScroll = input(true);
  autoRefresh = input(false);
  loading = input(false);
  loadingServices = input(false);

  selectedServiceChange = output<string>();
  tailLinesChange = output<number>();
  autoScrollChange = output<boolean>();
  autoRefreshChange = output<boolean>();
  refresh = output<void>();

  tailOptions = [
    { label: '50 lines', value: 50 },
    { label: '100 lines', value: 100 },
    { label: '200 lines', value: 200 },
    { label: '500 lines', value: 500 },
  ];

  onServiceChange(value: string) {
    this.selectedServiceChange.emit(value);
  }

  onTailChange(value: number) {
    this.tailLinesChange.emit(value);
  }
}
