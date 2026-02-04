import { Component, inject, signal, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService, ServerStatus, ProjectInfo, ConnectionInfo } from '@core/services/api.service';
import { ServerCardComponent } from './components/server-card/server-card.component';
import { StatsCardComponent } from './components/stats-card/stats-card.component';
import { WelcomeCardComponent } from './components/welcome-card/welcome-card.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    SkeletonModule,
    ServerCardComponent,
    StatsCardComponent,
    WelcomeCardComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit {
  private apiService = inject(ApiService);
  
  loading = signal(true);
  servers = signal<ServerStatus[]>([]);
  environments = signal<string[]>([]);
  project = signal<ProjectInfo | null>(null);
  connection = signal<ConnectionInfo | null>(null);
  checkingServers = signal<string[]>([]);
  
  onlineCount = computed(() => this.servers().filter(s => s.status === 'online').length);
  offlineCount = computed(() => this.servers().filter(s => s.status === 'offline' || s.status === 'error').length);
  
  ngOnInit() {
    this.loadData();
  }
  
  private loadData() {
    this.loading.set(true);
    
    this.apiService.getProjectInfo().subscribe({
      next: (info) => {
        this.project.set(info);
        this.environments.set(info.environments);
      },
    });
    
    this.apiService.getConnectionInfo().subscribe({
      next: (info) => {
        this.connection.set(info);
      },
    });
    
    this.apiService.getServers().subscribe({
      next: (response) => {
        this.servers.set(response.servers);
        this.environments.set(response.environments);
        this.loading.set(false);
        // Auto-check connectivity for all servers
        this.checkAllServersStatus();
      },
      error: () => {
        this.loading.set(false);
      },
    });
  }
  
  checkServerStatus(serverName: string) {
    this.checkingServers.update(current => [...current, serverName]);
    
    this.apiService.getServerStatus(serverName).subscribe({
      next: (status) => {
        this.servers.update(servers => 
          servers.map(s => s.name === serverName ? status : s)
        );
        this.checkingServers.update(current => current.filter(n => n !== serverName));
      },
      error: () => {
        this.servers.update(servers =>
          servers.map(s => s.name === serverName ? { ...s, status: 'error' as const, error: 'Connection failed' } : s)
        );
        this.checkingServers.update(current => current.filter(n => n !== serverName));
      },
    });
  }
  
  checkAllServersStatus() {
    for (const server of this.servers()) {
      this.checkServerStatus(server.name);
    }
  }
}
