import { Component, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TagModule } from 'primeng/tag';
import { ApiService } from '@core/services/api.service';
import { EnvironmentService } from '@core/services/environment.service';

@Component({
  selector: 'app-build',
  standalone: true,
  imports: [CommonModule, FormsModule, TagModule],
  templateUrl: './build.component.html',
  styleUrl: './build.component.scss',
})
export class BuildComponent {
  private apiService = inject(ApiService);
  envService = inject(EnvironmentService);

  building = signal(false);
  buildLogs = signal<string[]>([]);
  buildSuccess = signal<boolean | null>(null);

  servicesFilter = '';
  push = false;

  startBuild() {
    const env = this.envService.selectedOrUndefined();
    if (!env) return;

    this.building.set(true);
    this.buildLogs.set([]);
    this.buildSuccess.set(null);

    const body: Record<string, unknown> = { environment: env };
    if (this.servicesFilter.trim()) body['services'] = this.servicesFilter.trim();
    if (this.push) body['push'] = true;

    fetch('/api/operations/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((response) => {
        if (!response.ok || !response.body) {
          this.buildLogs.update(l => [...l, `Error: ${response.statusText}`]);
          this.building.set(false);
          this.buildSuccess.set(false);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const readChunk = (): void => {
          reader.read().then(({ done, value }) => {
            if (done) {
              this.building.set(false);
              if (this.buildSuccess() === null) this.buildSuccess.set(true);
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';
            for (const part of parts) {
              const eventMatch = part.match(/^event:\s*(.+)$/m);
              const dataMatch = part.match(/^data:\s*(.+)$/m);
              if (!dataMatch) continue;
              try {
                const data = JSON.parse(dataMatch[1]);
                const eventType = eventMatch ? eventMatch[1] : 'log';
                if (eventType === 'log') {
                  this.buildLogs.update(l => [...l, data.line]);
                } else if (eventType === 'done') {
                  this.buildSuccess.set(data.success);
                  this.building.set(false);
                }
              } catch { /* ignore parse errors */ }
            }
            readChunk();
          });
        };
        readChunk();
      })
      .catch((err) => {
        this.buildLogs.update(l => [...l, `Error: ${err.message}`]);
        this.building.set(false);
        this.buildSuccess.set(false);
      });
  }

  cancelBuild() {
    this.apiService.cancelOperation().subscribe();
  }
}
