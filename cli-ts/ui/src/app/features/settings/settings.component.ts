import { Component, inject, signal, OnInit, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, switchMap, debounceTime, catchError, of } from 'rxjs';
import { TabsModule } from 'primeng/tabs';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { ApiService } from '@core/services/api.service';
import { ConfigFormComponent } from './config-form/config-form.component';
import { ServersFormComponent } from './servers-form/servers-form.component';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TabsModule,
    TooltipModule,
    SkeletonModule,
    MessageModule,
    ToastModule,
    ConfigFormComponent,
    ServersFormComponent,
  ],
  providers: [MessageService],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  private apiService = inject(ApiService);
  private messageService = inject(MessageService);
  private destroyRef = inject(DestroyRef);

  // Form state
  configData = signal<Record<string, unknown> | null>(null);
  configFormLoading = signal(true);
  configFormError = signal<string | null>(null);

  serversData = signal<Record<string, unknown> | null>(null);
  serversFormLoading = signal(true);
  serversFormError = signal<string | null>(null);

  // YAML preview state (read-only)
  configYaml = signal('');
  configYamlLoading = signal(true);
  serversYaml = signal('');
  serversYamlLoading = signal(true);

  activeIndex = signal(0);

  // Auto-save subjects
  private configSave$ = new Subject<Record<string, unknown>>();
  private serversSave$ = new Subject<Record<string, unknown>>();

  constructor() {
    this.configSave$.pipe(
      debounceTime(800),
      switchMap(data => {
        this.configFormError.set(null);
        return this.apiService.updateConfig(data).pipe(
          catchError(err => {
            const errorMsg = err.error?.error || 'Failed to save config';
            this.configFormError.set(errorMsg);
            this.messageService.add({ severity: 'error', summary: 'Error', detail: errorMsg });
            return of(null);
          }),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(result => {
      if (result) this.loadYaml(0);
    });

    this.serversSave$.pipe(
      debounceTime(800),
      switchMap(data => {
        this.serversFormError.set(null);
        return this.apiService.updateServersConfig(data).pipe(
          catchError(err => {
            const errorMsg = err.error?.error || 'Failed to save servers config';
            this.serversFormError.set(errorMsg);
            this.messageService.add({ severity: 'error', summary: 'Error', detail: errorMsg });
            return of(null);
          }),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(result => {
      if (result) this.loadYaml(1);
    });
  }

  ngOnInit() {
    this.loadFormData();
    this.loadYaml(0);
    this.loadYaml(1);
  }

  // ── Form data loading ───────────────────────────────────────────────────

  loadFormData() {
    this.configFormLoading.set(true);
    this.configFormError.set(null);
    this.serversFormLoading.set(true);
    this.serversFormError.set(null);

    this.apiService.getConfig()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.configData.set(response.config);
          this.configFormLoading.set(false);
        },
        error: (err) => {
          this.configFormLoading.set(false);
          this.configFormError.set(err.error?.error || 'Failed to load config');
        },
      });

    this.apiService.getServersConfig()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.serversData.set(response.servers);
          this.serversFormLoading.set(false);
        },
        error: (err) => {
          this.serversFormLoading.set(false);
          this.serversFormError.set(err.error?.error || 'Failed to load servers config');
        },
      });
  }

  // ── YAML preview loading ──────────────────────────────────────────────

  loadYaml(index: number) {
    const fileName = index === 0 ? 'config.yml' : 'servers.yml';
    if (index === 0) this.configYamlLoading.set(true);
    else this.serversYamlLoading.set(true);

    this.apiService.getRawConfig(fileName)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (index === 0) {
            this.configYaml.set(response.content);
            this.configYamlLoading.set(false);
          } else {
            this.serversYaml.set(response.content);
            this.serversYamlLoading.set(false);
          }
        },
        error: () => {
          if (index === 0) {
            this.configYaml.set('# Failed to load config.yml');
            this.configYamlLoading.set(false);
          } else {
            this.serversYaml.set('# Failed to load servers.yml');
            this.serversYamlLoading.set(false);
          }
        },
      });
  }

  // ── Auto-save handlers ────────────────────────────────────────────────

  onConfigFormChange(data: Record<string, unknown>) {
    this.configSave$.next(data);
  }

  onServersFormChange(data: Record<string, unknown>) {
    this.serversSave$.next(data);
  }
}
