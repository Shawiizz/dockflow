import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { ApiService, ServerStatus } from '@core/services/api.service';

@Component({
  selector: 'app-servers',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    TagModule,
    SelectModule,
    TooltipModule,
    SkeletonModule,
    MessageModule,
  ],
  templateUrl: './servers.component.html',
  styleUrl: './servers.component.scss',
})
export class ServersComponent implements OnInit {
  private apiService = inject(ApiService);

  loading = signal(true);
  servers = signal<ServerStatus[]>([]);
  environments = signal<string[]>([]);
  selectedEnv = signal<string>('');
  checkingServers = signal<Set<string>>(new Set());

  envOptions = computed(() => [
    { label: 'All environments', value: '' },
    ...this.environments().map((e) => ({ label: e, value: e })),
  ]);

  filteredServers = computed(() => {
    const env = this.selectedEnv();
    if (!env) return this.servers();
    return this.servers().filter((s) => s.tags.includes(env));
  });

  onlineCount = computed(() => this.filteredServers().filter((s) => s.status === 'online').length);
  offlineCount = computed(() => this.filteredServers().filter((s) => s.status === 'offline' || s.status === 'error').length);
  unknownCount = computed(() => this.filteredServers().filter((s) => s.status === 'unknown').length);

  ngOnInit() {
    this.loadServers();
  }

  loadServers() {
    this.loading.set(true);
    this.apiService.getServers().subscribe({
      next: (response) => {
        this.servers.set(response.servers);
        this.environments.set(response.environments);
        this.loading.set(false);
        // Auto-check connectivity for all servers
        this.checkAll();
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }

  checkStatus(server: ServerStatus) {
    this.checkingServers.update((set) => new Set(set).add(server.name));

    this.apiService.getServerStatus(server.name).subscribe({
      next: (status) => {
        this.servers.update((servers) =>
          servers.map((s) => (s.name === server.name ? status : s)),
        );
        this.removeChecking(server.name);
      },
      error: () => {
        this.servers.update((servers) =>
          servers.map((s) =>
            s.name === server.name
              ? { ...s, status: 'error' as const, error: 'Connection failed' }
              : s,
          ),
        );
        this.removeChecking(server.name);
      },
    });
  }

  checkAll() {
    for (const server of this.filteredServers()) {
      this.checkStatus(server);
    }
  }

  isChecking(name: string): boolean {
    return this.checkingServers().has(name);
  }

  statusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined {
    switch (status) {
      case 'online': return 'success';
      case 'offline': return 'danger';
      case 'error': return 'danger';
      case 'checking': return 'info';
      default: return 'secondary';
    }
  }

  private removeChecking(name: string) {
    this.checkingServers.update((set) => {
      const next = new Set(set);
      next.delete(name);
      return next;
    });
  }
}
