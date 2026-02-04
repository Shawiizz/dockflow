import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TooltipModule } from 'primeng/tooltip';
import { RippleModule } from 'primeng/ripple';

interface NavItem {
  icon: string;
  label: string;
  route: string;
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule, TooltipModule, RippleModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  collapsed = input(false);
  collapsedChange = output<boolean>();
  
  navItems: NavItem[] = [
    { icon: 'pi pi-home', label: 'Dashboard', route: '/' },
    { icon: 'pi pi-server', label: 'Servers', route: '/servers' },
    { icon: 'pi pi-box', label: 'Services', route: '/services' },
    { icon: 'pi pi-list', label: 'Logs', route: '/logs' },
    { icon: 'pi pi-upload', label: 'Deploy', route: '/deploy' },
    { icon: 'pi pi-database', label: 'Accessories', route: '/accessories' },
    { icon: 'pi pi-cog', label: 'Settings', route: '/settings' },
  ];
}
