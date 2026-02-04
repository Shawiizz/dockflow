import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TabsModule } from 'primeng/tabs';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { ApiService } from '@core/services/api.service';

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
  ],
  providers: [MessageService],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  private apiService = inject(ApiService);
  private messageService = inject(MessageService);

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

    this.apiService.getRawConfig(tab.fileName).subscribe({
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

    this.saving.set(true);
    this.updateTab(index, { error: null });

    this.apiService.saveRawConfig(tab.fileName, tab.content).subscribe({
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
