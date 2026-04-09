import { Component, input, output, inject, OnInit, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { TooltipModule } from 'primeng/tooltip';
import { RippleModule } from 'primeng/ripple';
import { DrawerModule } from 'primeng/drawer';
import { ButtonModule } from 'primeng/button';
import { filter, Subscription } from 'rxjs';

interface NavItem {
  icon: string;
  label: string;
  route: string;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
  separator?: boolean;
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [NgTemplateOutlet, RouterModule, TooltipModule, RippleModule, DrawerModule, ButtonModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarComponent implements OnInit, OnDestroy {
  collapsed = input(false);
  collapsedChange = output<boolean>();
  mobileOpen = input(false);
  mobileOpenChange = output<boolean>();
  isMobile = input(false);

  private router = inject(Router);
  private routerSub?: Subscription;

  ngOnInit() {
    this.routerSub = this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
    ).subscribe(() => {
      if (this.isMobile()) {
        this.mobileOpenChange.emit(false);
      }
    });
  }

  ngOnDestroy() {
    this.routerSub?.unsubscribe();
  }

  navGroups: NavGroup[] = [
    {
      items: [
        { icon: 'pi pi-home', label: 'Dashboard', route: '/' },
      ],
    },
    {
      label: 'Infrastructure',
      items: [
        { icon: 'pi pi-server', label: 'Servers', route: '/servers' },
        { icon: 'pi pi-box', label: 'Services', route: '/services' },
        { icon: 'pi pi-database', label: 'Accessories', route: '/accessories' },
        { icon: 'pi pi-sitemap', label: 'Topology', route: '/topology' },
      ],
    },
    {
      label: 'Operations',
      items: [
        { icon: 'pi pi-upload', label: 'Deploy', route: '/deploy' },
        { icon: 'pi pi-hammer', label: 'Build', route: '/build' },
      ],
    },
    {
      label: 'Observability',
      items: [
        { icon: 'pi pi-list', label: 'Logs', route: '/logs' },
        { icon: 'pi pi-chart-bar', label: 'Monitoring', route: '/monitoring' },
        { icon: 'pi pi-wrench', label: 'Resources', route: '/resources' },
      ],
    },
    {
      separator: true,
      items: [
        { icon: 'pi pi-cog', label: 'Settings', route: '/settings' },
      ],
    },
  ];
}
