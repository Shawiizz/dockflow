import { Component, inject, signal, OnInit, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TabsModule } from 'primeng/tabs';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ApiService } from '@core/services/api.service';
import type { HasUnsavedChanges } from '@core/guards/unsaved-changes.guard';

interface ConfigTab {
  fileName: string;
  label: string;
  icon: string;
  content: string;
  originalContent: string;
  loading: boolean;
  dirty: boolean;
  error: string | null;
}

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
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit, HasUnsavedChanges {
  private apiService = inject(ApiService);
  private messageService = inject(MessageService);
  private confirmService = inject(ConfirmationService);
  private destroyRef = inject(DestroyRef);

  tabs = signal<ConfigTab[]>([
    {
      fileName: 'config.yml',
      label: 'Config',
      icon: 'pi pi-cog',
      content: '',
      originalContent: '',
      loading: true,
      dirty: false,
      error: null,
    },
    {
      fileName: 'servers.yml',
      label: 'Servers',
      icon: 'pi pi-server',
      content: '',
      originalContent: '',
      loading: true,
      dirty: false,
      error: null,
    },
  ]);

  activeIndex = signal(0);
  saving = signal(false);

  hasUnsavedChanges(): boolean {
    return this.tabs().some(t => t.dirty);
  }

  ngOnInit() {
    this.loadAllConfigs();
  }

  loadAllConfigs() {
    const currentTabs = this.tabs();
    for (let i = 0; i < currentTabs.length; i++) {
      this.loadConfig(i);
    }
  }

  loadConfig(index: number) {
    const tab = this.tabs()[index];
    this.updateTab(index, { loading: true, error: null });

    this.apiService.getRawConfig(tab.fileName)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.updateTab(index, {
            content: response.content,
            originalContent: response.content,
            loading: false,
            dirty: false,
          });
        },
        error: (err) => {
          this.updateTab(index, {
            loading: false,
            error: err.error?.error || `Failed to load ${tab.fileName}`,
          });
        },
      });
  }

  onContentChange(index: number, content: string) {
    const tab = this.tabs()[index];
    this.updateTab(index, {
      content,
      dirty: content !== tab.originalContent,
    });
  }

  save(index: number) {
    const tab = this.tabs()[index];
    if (!tab.dirty) return;

    this.confirmService.confirm({
      message: `Are you sure you want to save changes to ${tab.fileName}? This will overwrite the current configuration.`,
      header: 'Confirm Save',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Save',
      rejectLabel: 'Cancel',
      accept: () => this.doSave(index),
    });
  }

  private doSave(index: number) {
    const tab = this.tabs()[index];
    this.saving.set(true);
    this.updateTab(index, { error: null });

    this.apiService.saveRawConfig(tab.fileName, tab.content)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.updateTab(index, {
            originalContent: tab.content,
            dirty: false,
          });
          this.saving.set(false);
          this.messageService.add({
            severity: 'success',
            summary: 'Saved',
            detail: `${tab.fileName} updated successfully.`,
          });
        },
        error: (err) => {
          this.saving.set(false);
          const errorMsg = err.error?.error || `Failed to save ${tab.fileName}`;
          this.updateTab(index, { error: errorMsg });
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: errorMsg,
          });
        },
      });
  }

  revert(index: number) {
    const tab = this.tabs()[index];
    this.updateTab(index, {
      content: tab.originalContent,
      dirty: false,
    });
  }

  private updateTab(index: number, updates: Partial<ConfigTab>) {
    this.tabs.update((tabs) =>
      tabs.map((tab, i) => (i === index ? { ...tab, ...updates } : tab)),
    );
  }
}
