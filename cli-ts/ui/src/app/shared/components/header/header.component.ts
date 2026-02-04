import { Component, input, output, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { RippleModule } from 'primeng/ripple';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService } from '@core/services/api.service';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, TooltipModule, RippleModule, SkeletonModule],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
})
export class HeaderComponent implements OnInit {
  sidebarCollapsed = input(false);
  toggleSidebar = output<void>();
  
  private apiService = inject(ApiService);
  
  projectName = signal('Dockflow');
  environments = signal<string[]>([]);
  selectedEnv = '';
  connectionReady = signal(false);
  loadingProject = signal(true);
  loadingConnection = signal(true);
  refreshing = signal(false);
  
  environmentOptions = () => this.environments().map(e => ({ label: e, value: e }));
  
  ngOnInit() {
    this.loadProjectInfo();
    this.loadConnectionInfo();
  }
  
  private loadProjectInfo() {
    this.loadingProject.set(true);
    this.apiService.getProjectInfo().subscribe({
      next: (info) => {
        this.projectName.set(info.projectName);
        this.environments.set(info.environments);
        if (info.environments.length > 0 && !this.selectedEnv) {
          this.selectedEnv = info.environments[0];
        }
        this.loadingProject.set(false);
      },
      error: () => {
        this.loadingProject.set(false);
      },
    });
  }
  
  private loadConnectionInfo() {
    this.loadingConnection.set(true);
    this.apiService.getConnectionInfo().subscribe({
      next: (info) => {
        this.connectionReady.set(info.ready);
        this.loadingConnection.set(false);
      },
      error: () => {
        this.connectionReady.set(false);
        this.loadingConnection.set(false);
      },
    });
  }
  
  refresh() {
    this.refreshing.set(true);
    this.loadProjectInfo();
    this.loadConnectionInfo();
    // Reset refreshing after a short delay
    setTimeout(() => this.refreshing.set(false), 600);
  }
}
