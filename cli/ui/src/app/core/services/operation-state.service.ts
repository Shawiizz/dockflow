import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';

interface StreamCtx {
  logs: ReturnType<typeof signal<string[]>>;
  running: ReturnType<typeof signal<boolean>>;
  success: ReturnType<typeof signal<boolean | null>>;
}

@Injectable({
  providedIn: 'root',
})
export class OperationStateService {
  private apiService = inject(ApiService);

  // Build state
  building = signal(false);
  buildLogs = signal<string[]>([]);
  buildSuccess = signal<boolean | null>(null);

  // Deploy state
  deploying = signal(false);
  deployLogs = signal<string[]>([]);
  deploySuccess = signal<boolean | null>(null);

  private buildCtx: StreamCtx = { logs: this.buildLogs, running: this.building, success: this.buildSuccess };
  private deployCtx: StreamCtx = { logs: this.deployLogs, running: this.deploying, success: this.deploySuccess };

  private reconnected = false;

  startBuild(body: Record<string, unknown>) {
    this.building.set(true);
    this.buildLogs.set([]);
    this.buildSuccess.set(null);
    this.streamViaPost('/api/operations/build', body, this.buildCtx);
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
    this.streamViaPost('/api/operations/deploy', body, this.deployCtx);
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

  /**
   * Reattach to the operation running (or last finished) on the server, if any.
   * Safe to call repeatedly — only runs once.
   */
  reconnect() {
    if (this.reconnected) return;
    this.reconnected = true;

    this.apiService.getOperationStatus().subscribe({
      next: (status) => {
        if (!status.type) return; // nothing to reattach to
        const ctx = status.type === 'build' ? this.buildCtx : this.deployCtx;
        ctx.logs.set([]);
        ctx.success.set(null);
        ctx.running.set(!!status.running);
        this.streamViaGet('/api/operations/stream', ctx);
      },
      error: () => { /* status check failed — nothing to reattach to */ },
    });
  }

  private streamViaPost(url: string, body: Record<string, unknown>, ctx: StreamCtx) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((response) => this.consumeStream(response, ctx))
      .catch((err: Error) => this.onStreamError(err, ctx));
  }

  private streamViaGet(url: string, ctx: StreamCtx) {
    fetch(url)
      .then((response) => this.consumeStream(response, ctx))
      .catch((err: Error) => this.onStreamError(err, ctx));
  }

  private consumeStream(response: Response, ctx: StreamCtx) {
    if (!response.ok || !response.body) {
      // A 404 here just means "nothing to reattach to" for a reconnect — not a real error.
      if (response.status !== 404) {
        ctx.logs.update(l => [...l, `Error: ${response.statusText}`]);
        ctx.success.set(false);
      }
      ctx.running.set(false);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readChunk = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) {
          ctx.running.set(false);
          if (ctx.success() === null) ctx.success.set(true);
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
            }
          } catch { /* ignore parse errors */ }
        }
        readChunk();
      }).catch((err: Error) => this.onStreamError(err, ctx));
    };
    readChunk();
  }

  private onStreamError(err: Error, ctx: StreamCtx) {
    ctx.logs.update(l => [...l, `--- Connection lost: ${err.message} ---`]);
    ctx.running.set(false);
    ctx.success.set(false);
  }
}
