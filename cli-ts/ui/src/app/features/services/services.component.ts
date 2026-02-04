import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ProgressBarModule } from 'primeng/progressbar';
import { ApiService } from '@core/services/api.service';
import type { ServiceInfo } from '@api-types';

@Component({
  selector: 'app-services',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    TagModule,
    SelectModule,
    TooltipModule,
    SkeletonModule,
    ProgressBarModule,
  ],
  templateUrl: './services.component.html',
  styleUrl: './services.component.scss',
})
export class ServicesComponent implements OnInit {
  private apiService = inject(ApiService);

  loading = signal(true);
  services = signal<ServiceInfo[]>([]);
  stackName = signal('');
  environments = signal<string[]>([]);
  selectedEnv = signal<string>('');
  message = signal<string | null>(null);

  envOptions = computed(() => [
    { label: 'Default', value: '' },
    ...this.environments().map((e) => ({ label: e, value: e })),
  ]);

  runningCount = computed(() => this.services().filter((s) => s.state === 'running').length);
  stoppedCount = computed(() => this.services().filter((s) => s.state === 'stopped').length);

  ngOnInit() {
    this.loadEnvironments();
    this.loadServices();
  }

  loadEnvironments() {
    this.apiService.getEnvironments().subscribe({
      next: (envs) => this.environments.set(envs),
    });
  }

  loadServices() {
    this.loading.set(true);
    this.message.set(null);

    const env = this.selectedEnv() || undefined;
    this.apiService.getServices(env).subscribe({
      next: (response) => {
        this.services.set(response.services);
        this.stackName.set(response.stackName);
        if (response.message) {
          this.message.set(response.message);
        }
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.message.set('Failed to load services.');
      },
    });
  }

  onEnvChange() {
    this.loadServices();
  }

  replicaPercent(service: ServiceInfo): number {
    if (service.replicas === 0) return 0;
    return Math.round((service.replicasRunning / service.replicas) * 100);
  }

  stateSeverity(state: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (state) {
      case 'running': return 'success';
      case 'stopped': return 'danger';
      case 'paused': return 'warn';
      case 'error': return 'danger';
      default: return 'secondary';
    }
  }

  imageShort(image: string): string {
    // Strip registry prefix and hash for display
    const parts = image.split('/');
    const last = parts[parts.length - 1];
    return last.split('@')[0];
  }
}
