import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';

@Injectable({
  providedIn: 'root',
})
export class OperationStateService {
  private apiService = inject(ApiService);

  // Build state
  building = signal(false);
  buildLogs = signal<string[]>([]);
  buildSuccess = signal<boolean | null>(null);
  private buildReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  // Deploy state
  deploying = signal(false);
  deployLogs = signal<string[]>([]);
  deploySuccess = signal<boolean | null>(null);
  private deployReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  startBuild(body: Record<string, unknown>) {
    this.building.set(true);
    this.buildLogs.set([]);
    this.buildSuccess.set(null);

    this.streamOperation('/api/operations/build', body, {
      logs: this.buildLogs,
      running: this.building,
      success: this.buildSuccess,
      setReader: (r) => this.buildReader = r,
    });
  }

  cancelBuild() {
    this.apiService.cancelOperation().subscribe({
      next: () => {
        this.building.set(false);
        this.buildSuccess.set(false);
        this.buildLogs.update(l => [...l, '--- Operation cancelled ---']);
      },
    });
  }

  clearBuild() {
    this.buildLogs.set([]);
    this.buildSuccess.set(null);
  }

  startDeploy(body: Record<string, unknown>) {
    this.deploying.set(true);
    this.deployLogs.set([]);
    this.deploySuccess.set(null);

    this.streamOperation('/api/operations/deploy', body, {
      logs: this.deployLogs,
      running: this.deploying,
      success: this.deploySuccess,
      setReader: (r) => this.deployReader = r,
    });
  }

  cancelDeploy() {
    this.apiService.cancelOperation().subscribe({
      next: () => {
        this.deploying.set(false);
        this.deploySuccess.set(false);
        this.deployLogs.update(l => [...l, '--- Operation cancelled ---']);
      },
    });
  }

  clearDeploy() {
    this.deployLogs.set([]);
    this.deploySuccess.set(null);
  }

  private streamOperation(
    url: string,
    body: Record<string, unknown>,
    ctx: {
      logs: ReturnType<typeof signal<string[]>>;
      running: ReturnType<typeof signal<boolean>>;
      success: ReturnType<typeof signal<boolean | null>>;
      setReader: (r: ReadableStreamDefaultReader<Uint8Array> | null) => void;
    },
  ) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((response) => {
        if (!response.ok || !response.body) {
          ctx.logs.update(l => [...l, `Error: ${response.statusText}`]);
          ctx.running.set(false);
          ctx.success.set(false);
          return;
        }
        const reader = response.body.getReader();
        ctx.setReader(reader);
        const decoder = new TextDecoder();
        let buffer = '';

        const readChunk = (): void => {
          reader.read().then(({ done, value }) => {
            if (done) {
              ctx.running.set(false);
              if (ctx.success() === null) ctx.success.set(true);
              ctx.setReader(null);
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
                  ctx.logs.update(l => [...l, data.line]);
                } else if (eventType === 'done') {
                  ctx.success.set(data.success);
                  ctx.running.set(false);
                  ctx.setReader(null);
                }
              } catch { /* ignore parse errors */ }
            }
            readChunk();
          });
        };
        readChunk();
      })
      .catch((err) => {
        ctx.logs.update(l => [...l, `Error: ${err.message}`]);
        ctx.running.set(false);
        ctx.success.set(false);
        ctx.setReader(null);
      });
  }
}
