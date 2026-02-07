import { Routes } from '@angular/router';
import { unsavedChangesGuard } from './core/guards/unsaved-changes.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
  },
  {
    path: 'servers',
    loadComponent: () => import('./features/servers/servers.component').then(m => m.ServersComponent),
  },
  {
    path: 'services',
    loadComponent: () => import('./features/services/services.component').then(m => m.ServicesComponent),
  },
  {
    path: 'logs',
    loadComponent: () => import('./features/logs/logs.component').then(m => m.LogsComponent),
  },
  {
    path: 'deploy',
    loadComponent: () => import('./features/deploy/deploy.component').then(m => m.DeployComponent),
  },
  {
    path: 'build',
    loadComponent: () => import('./features/build/build.component').then(m => m.BuildComponent),
  },
  {
    path: 'accessories',
    loadComponent: () => import('./features/accessories/accessories.component').then(m => m.AccessoriesComponent),
  },
  {
    path: 'monitoring',
    loadComponent: () => import('./features/monitoring/monitoring.component').then(m => m.MonitoringComponent),
  },
  {
    path: 'resources',
    loadComponent: () => import('./features/resources/resources.component').then(m => m.ResourcesComponent),
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent),
    canDeactivate: [unsavedChangesGuard],
  },
  {
    path: '**',
    redirectTo: '',
  },
];
