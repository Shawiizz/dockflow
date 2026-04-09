import { Component, input, output, inject, signal, OnInit, DestroyRef } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, NavigationEnd } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { EnvironmentService } from '@core/services/environment.service';
import { ProjectInfoService } from '@core/services/project-info.service';
import { ThemeService } from '@core/services/theme.service';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [NgClass, FormsModule, SelectModule, TooltipModule, ButtonModule, SkeletonModule],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
})
export class HeaderComponent implements OnInit {
  sidebarCollapsed = input(false);
  toggleSidebar = output<void>();
  isMobile = input(false);

  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  envService = inject(EnvironmentService);
  projectInfoService = inject(ProjectInfoService);
  themeService = inject(ThemeService);

  pageTitle = signal('Dashboard');

  ngOnInit() {
    this.envService.load();
    this.projectInfoService.load();

    // Track current page title
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(event => {
      this.pageTitle.set(this.getPageTitle(event.urlAfterRedirects));
    });
  }

  refresh() {
    this.projectInfoService.reload();
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
      'build': 'Build',
      'accessories': 'Accessories',
      'monitoring': 'Monitoring',
      'resources': 'Resources',
      'topology': 'Topology',
      'settings': 'Settings',
    };
    return titles[path] || 'Dashboard';
  }
}
