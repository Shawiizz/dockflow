import {
  Component,
  input,
  effect,
  OnDestroy,
  AfterViewInit,
  viewChild,
  ElementRef,
} from '@angular/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

@Component({
  selector: 'app-terminal-output',
  standalone: true,
  template: `<div #terminalEl class="terminal-output-container"></div>`,
  styles: `
    :host {
      display: block;
    }
    .terminal-output-container {
      height: 100%;
      min-height: 200px;
    }
    :host ::ng-deep .xterm {
      height: 100%;
      padding: 0.5rem;
    }
  `,
})
export class TerminalOutputComponent implements AfterViewInit, OnDestroy {
  lines = input.required<string[]>();

  private terminalEl = viewChild<ElementRef<HTMLDivElement>>('terminalEl');

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private writtenCount = 0;

  ngAfterViewInit() {
    this.initTerminal();
  }

  private initTerminal() {
    const container = this.terminalEl()?.nativeElement;
    if (!container) return;

    this.terminal = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 10000,
      convertEol: true,
      theme: {
        background: '#0a0a0a',
        foreground: '#fafafa',
        cursor: '#0a0a0a',
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
    this.terminal.open(container);
    this.fitAddon.fit();

    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon?.fit();
    });
    this.resizeObserver.observe(container);

    // Write any lines already present
    const current = this.lines();
    for (const line of current) {
      this.terminal.writeln(line);
    }
    this.writtenCount = current.length;
  }

  constructor() {
    // Track new lines and write only the new ones
    effect(() => {
      const allLines = this.lines();
      if (!this.terminal) return;

      for (let i = this.writtenCount; i < allLines.length; i++) {
        this.terminal.writeln(allLines[i]);
      }
      this.writtenCount = allLines.length;
    });
  }

  reset() {
    this.terminal?.clear();
    this.writtenCount = 0;
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }
}
