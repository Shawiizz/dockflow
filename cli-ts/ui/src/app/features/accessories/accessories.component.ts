import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService } from '@core/services/api.service';
import type { AccessoryInfo } from '@api-types';

@Component({
  selector: 'app-accessories',
  standalone: true,
  imports: [CommonModule, TagModule, TooltipModule, SkeletonModule],
  templateUrl: './accessories.component.html',
  styleUrl: './accessories.component.scss',
})
export class AccessoriesComponent implements OnInit {
  private apiService = inject(ApiService);

  loading = signal(true);
  accessories = signal<AccessoryInfo[]>([]);

  ngOnInit() {
    this.loadAccessories();
  }

  loadAccessories() {
    this.loading.set(true);
    this.apiService.getAccessories().subscribe({
      next: (response) => {
        this.accessories.set(response.accessories);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  envEntries(env?: Record<string, string>): Array<{ key: string; value: string }> {
    if (!env) return [];
    return Object.entries(env).map(([key, value]) => ({ key, value }));
  }
}
