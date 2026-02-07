import { Component, input, output, inject, signal, OnInit, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, NavigationEnd } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, forkJoin } from 'rxjs';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { RippleModule } from 'primeng/ripple';
import { SkeletonModule } from 'primeng/skeleton';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';
import { ThemeService } from '@core/services/theme.service';

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
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  envService = inject(EnvironmentService);
  themeService = inject(ThemeService);

  projectName = signal('Dockflow');
  connectionReady = signal(false);
  loadingProject = signal(true);
  loadingConnection = signal(true);
  refreshing = signal(false);
  pageTitle = signal('Dashboard');

  ngOnInit() {
    this.envService.load();
    this.loadProjectInfo();
    this.loadConnectionInfo();

    // Track current page title
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(event => {
      this.pageTitle.set(this.getPageTitle(event.urlAfterRedirects));
    });
  }

  private loadProjectInfo() {
    this.loadingProject.set(true);
    this.apiService.getProjectInfo()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (info) => {
          this.projectName.set(info.projectName);
          this.loadingProject.set(false);
        },
        error: () => {
          this.loadingProject.set(false);
        },
      });
  }

  private loadConnectionInfo() {
    this.loadingConnection.set(true);
    this.apiService.getConnectionInfo()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
    forkJoin([
      this.apiService.getProjectInfo(),
      this.apiService.getConnectionInfo(),
    ]).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ([project, connection]) => {
        this.projectName.set(project.projectName);
        this.connectionReady.set(connection.ready);
        this.refreshing.set(false);
      },
      error: () => {
        this.refreshing.set(false);
      },
    });
    this.envService.reload();
  }

  private getPageTitle(url: string): string {
    const path = url.split('?')[0].replace(/^\//, '');
    const titles: Record<string, string> = {
      '': 'Dashboard',
      'servers': 'Servers',
      'services': 'Services',
      'logs': 'Logs',
      'deploy': 'Deployments',
      'accessories': 'Accessories',
      'settings': 'Settings',
    };
    return titles[path] || 'Dashboard';
  }
}
