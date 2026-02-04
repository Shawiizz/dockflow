import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  ElementRef,
  viewChild,
  AfterViewChecked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ApiService } from '@core/services/api.service';
import type { LogEntry, ServiceInfo } from '@api-types';

@Component({
  selector: 'app-logs',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SelectModule,
    TooltipModule,
    SkeletonModule,
    ToggleSwitchModule,
  ],
  templateUrl: './logs.component.html',
  styleUrl: './logs.component.scss',
})
export class LogsComponent implements OnInit, AfterViewChecked {
  private apiService = inject(ApiService);
  private route = inject(ActivatedRoute);

  logContainer = viewChild<ElementRef<HTMLDivElement>>('logContainer');

  loading = signal(false);
  loadingServices = signal(true);
  services = signal<ServiceInfo[]>([]);
  logs = signal<LogEntry[]>([]);
  environments = signal<string[]>([]);
  selectedEnv = signal<string>('');
  selectedService = signal<string>('');
  autoScroll = true;
  tailLines = 100;
  private shouldScrollToBottom = false;

  envOptions = computed(() => [
    { label: 'Default', value: '' },
    ...this.environments().map((e) => ({ label: e, value: e })),
  ]);

  serviceOptions = computed(() =>
    this.services().map((s) => ({ label: s.name, value: s.name })),
  );

  lineCountOptions = [
    { label: '50 lines', value: 50 },
    { label: '100 lines', value: 100 },
    { label: '200 lines', value: 200 },
    { label: '500 lines', value: 500 },
  ];

  ngOnInit() {
    this.loadEnvironments();
    this.loadServices();

    // Check for service query param
    this.route.queryParams.subscribe((params) => {
      if (params['service']) {
        this.selectedService.set(params['service']);
        this.loadLogs();
      }
    });
  }

  ngAfterViewChecked() {
    if (this.shouldScrollToBottom && this.autoScroll) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
    }
  }

  loadEnvironments() {
    this.apiService.getEnvironments().subscribe({
      next: (envs) => this.environments.set(envs),
    });
  }

  loadServices() {
    this.loadingServices.set(true);
    const env = this.selectedEnv() || undefined;
    this.apiService.getServices(env).subscribe({
      next: (response) => {
        this.services.set(response.services);
        this.loadingServices.set(false);
      },
      error: () => {
        this.loadingServices.set(false);
      },
    });
  }

  loadLogs() {
    const service = this.selectedService();
    if (!service) return;

    this.loading.set(true);
    const env = this.selectedEnv() || undefined;
    this.apiService.getServiceLogs(service, env, this.tailLines).subscribe({
      next: (response) => {
        this.logs.set(response.logs);
        this.loading.set(false);
        this.shouldScrollToBottom = true;
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  onServiceChange() {
    this.logs.set([]);
    this.loadLogs();
  }

  onEnvChange() {
    this.loadServices();
    if (this.selectedService()) {
      this.loadLogs();
    }
  }

  refresh() {
    this.loadLogs();
  }

  clearLogs() {
    this.logs.set([]);
  }

  formatTimestamp(ts: string): string {
    try {
      const date = new Date(ts);
      return date.toLocaleTimeString('en-US', { hour12: false });
    } catch {
      return ts;
    }
  }

  private scrollToBottom() {
    const container = this.logContainer();
    if (container) {
      const el = container.nativeElement;
      el.scrollTop = el.scrollHeight;
    }
  }
}
