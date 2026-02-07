import {
  Component,
  input,
  output,
  signal,
  OnDestroy,
  AfterViewInit,
  viewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DialogModule } from 'primeng/dialog';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

@Component({
  selector: 'app-ssh-terminal',
  standalone: true,
  imports: [CommonModule, DialogModule],
  templateUrl: './ssh-terminal.component.html',
  styleUrl: './ssh-terminal.component.scss',
})
export class SshTerminalComponent implements AfterViewInit, OnDestroy {
  serverName = input.required<string>();
  serverHost = input<string>('');
  visible = input(false);
  visibleChange = output<boolean>();
  mode = input<'ssh' | 'exec'>('ssh');
  env = input<string>('');

  terminalContainer = viewChild<ElementRef<HTMLDivElement>>('terminalEl');

  connected = signal(false);
  error = signal<string | null>(null);
  connecting = signal(true);

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private ws: WebSocket | null = null;
  private resizeObserver: ResizeObserver | null = null;

  ngAfterViewInit() {
    // Terminal init deferred until dialog opens
  }

  onDialogShow() {
    // Small delay to let the dialog fully render
    setTimeout(() => this.initTerminal(), 100);
  }

  onDialogHide() {
    this.cleanup();
    this.visibleChange.emit(false);
  }

  private initTerminal() {
    const container = this.terminalContainer()?.nativeElement;
    if (!container) return;

    this.connecting.set(true);
    this.error.set(null);
    this.connected.set(false);

    // Create xterm.js instance
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#0a0a0a',
        foreground: '#fafafa',
        cursor: '#3b82f6',
        selectionBackground: '#3b82f644',
        black: '#171717',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#fafafa',
        brightBlack: '#71717a',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    this.terminal.open(container);
    this.fitAddon.fit();

    // Auto-fit on resize
    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon?.fit();
    });
    this.resizeObserver.observe(container);

    // Connect WebSocket
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl: string;
    if (this.mode() === 'exec') {
      const envParam = this.env() ? `?env=${encodeURIComponent(this.env())}` : '';
      wsUrl = `${protocol}//${location.host}/ws/exec/${encodeURIComponent(this.serverName())}${envParam}`;
    } else {
      wsUrl = `${protocol}//${location.host}/ws/ssh/${encodeURIComponent(this.serverName())}`;
    }

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      const label = this.mode() === 'exec'
        ? `Connecting to container for ${this.serverName()}...`
        : `Connecting to ${this.serverName()} (${this.serverHost()})...`;
      this.terminal?.writeln(`${label}\r\n`);
    };

    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'connected') {
            this.connected.set(true);
            this.connecting.set(false);
            return;
          }
          if (msg.type === 'error') {
            this.error.set(msg.message);
            this.connecting.set(false);
            this.terminal?.writeln(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
            return;
          }
          if (msg.type === 'exit') {
            this.connected.set(false);
            this.terminal?.writeln(`\r\n\x1b[33mSession ended (exit code: ${msg.code})\x1b[0m\r\n`);
            return;
          }
          // Regular text
          this.terminal?.write(event.data);
        } catch {
          // Not JSON, write as text
          this.terminal?.write(event.data);
        }
      } else {
        // Binary data
        this.terminal?.write(new Uint8Array(event.data));
      }
    };

    this.ws.onclose = () => {
      this.connected.set(false);
      this.connecting.set(false);
      this.terminal?.writeln('\r\n\x1b[90mConnection closed.\x1b[0m');
    };

    this.ws.onerror = () => {
      this.connecting.set(false);
      this.error.set('WebSocket connection failed');
      this.terminal?.writeln('\r\n\x1b[31mWebSocket connection failed.\x1b[0m');
    };

    // Send terminal input to WebSocket
    this.terminal.onData((data: string) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(data);
      }
    });

    // Send resize events
    this.terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });
  }

  private cleanup() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }

    this.fitAddon = null;
    this.connected.set(false);
    this.connecting.set(false);
    this.error.set(null);
  }

  ngOnDestroy() {
    this.cleanup();
  }
}
