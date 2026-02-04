import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SkeletonModule } from 'primeng/skeleton';

@Component({
  selector: 'app-stats-card',
  standalone: true,
  imports: [CommonModule, SkeletonModule],
  templateUrl: './stats-card.component.html',
  styleUrl: './stats-card.component.scss',
})
export class StatsCardComponent {
  icon = input.required<string>();
  label = input.required<string>();
  value = input.required<number>();
  variant = input<'default' | 'success' | 'error' | 'warning' | 'info'>('default');
  loading = input(false);
}
