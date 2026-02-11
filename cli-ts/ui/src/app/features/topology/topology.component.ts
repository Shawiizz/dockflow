import { Component, inject, signal, computed, OnInit, OnDestroy, DestroyRef, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ApiService } from '@core/services/api.service';
import type { ComposeFile } from '@core/services/api.service';

const CARD_WIDTH = 220;
const CARD_HEIGHT = 120;
const STORAGE_KEY = 'dockflow-topology-positions';

interface ServiceCard {
  name: string;
  image?: string;
  replicas?: number;
  ports?: string[];
  x: number;
  y: number;
}

interface ServerCard {
  name: string;
  role: string;
  host?: string;
  tags: string[];
  x: number;
  y: number;
}

interface Connection {
  serviceName: string;
  serverName: string;
  constraintType: 'hostname' | 'role';
  constraintValue: string;
  implicit?: boolean;
}

interface DragState {
  type: 'card' | 'connection';
  target?: string;
  cardType?: 'service' | 'server';
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
}

@Component({
  selector: 'app-topology',
  standalone: true,
  imports: [
    CommonModule,
    TooltipModule,
    SkeletonModule,
    MessageModule,
    ToastModule,
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './topology.component.html',
  styleUrl: './topology.component.scss',
})
export class TopologyComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private messageService = inject(MessageService);
  private confirmService = inject(ConfirmationService);
  private destroyRef = inject(DestroyRef);

  @ViewChild('canvas', { static: false }) canvasRef!: ElementRef<HTMLDivElement>;

  loading = signal(true);
  error = signal<string | null>(null);
  saving = signal(false);
  dirty = signal(false);

  services = signal<ServiceCard[]>([]);
  servers = signal<ServerCard[]>([]);
  connections = signal<Connection[]>([]);

  private compose: ComposeFile | null = null;
  private dragState: DragState | null = null;

  pendingLine = signal<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  pendingServiceName = signal<string | null>(null);

  private boundMouseMove = this.onMouseMove.bind(this);
  private boundMouseUp = this.onMouseUp.bind(this);

  canvasWidth = computed(() => {
    const allCards = [...this.services(), ...this.servers()];
    if (allCards.length === 0) return 900;
    const maxX = Math.max(...allCards.map(c => c.x + CARD_WIDTH + 40));
    return Math.max(900, maxX);
  });

  canvasHeight = computed(() => {
    const allCards = [...this.services(), ...this.servers()];
    if (allCards.length === 0) return 500;
    const maxY = Math.max(...allCards.map(c => c.y + CARD_HEIGHT + 40));
    return Math.max(500, maxY);
  });

  connectionPaths = computed(() => {
    const svcs = this.services();
    const srvs = this.servers();
    return this.connections().map(conn => {
      const svc = svcs.find(s => s.name === conn.serviceName);
      const srv = srvs.find(s => s.name === conn.serverName);
      if (!svc || !srv) return null;

      const x1 = svc.x + CARD_WIDTH;
      const y1 = svc.y + CARD_HEIGHT / 2;
      const x2 = srv.x;
      const y2 = srv.y + CARD_HEIGHT / 2;
      const dx = Math.abs(x2 - x1) * 0.5;

      return {
        path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        conn,
        midX: (x1 + x2) / 2,
        midY: (y1 + y2) / 2,
      };
    }).filter(Boolean) as { path: string; conn: Connection; midX: number; midY: number }[];
  });

  pendingPath = computed(() => {
    const line = this.pendingLine();
    if (!line) return null;
    const { x1, y1, x2, y2 } = line;
    const dx = Math.abs(x2 - x1) * 0.5;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  });

  ngOnInit() {
    this.loadData();
  }

  ngOnDestroy() {
    document.removeEventListener('mousemove', this.boundMouseMove);
    document.removeEventListener('mouseup', this.boundMouseUp);
  }

  loadData() {
    this.loading.set(true);
    this.error.set(null);

    forkJoin({
      compose: this.apiService.getCompose(),
      servers: this.apiService.getServersConfig(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ compose, servers }) => {
          this.compose = compose.compose;

          const savedPositions = this.loadPositions();

          // Parse services from compose
          const serviceCards: ServiceCard[] = [];
          if (compose.compose?.services) {
            let idx = 0;
            for (const [name, svc] of Object.entries(compose.compose.services)) {
              const saved = savedPositions[`service:${name}`];
              serviceCards.push({
                name,
                image: svc.image,
                replicas: svc.deploy?.replicas,
                ports: svc.ports,
                x: saved?.x ?? 50,
                y: saved?.y ?? 30 + idx * 140,
              });
              idx++;
            }
          }
          this.services.set(serviceCards);

          // Parse servers from config
          const serverCards: ServerCard[] = [];
          const serversData = (servers.servers ?? {}) as Record<string, Record<string, unknown>>;
          let idx = 0;
          for (const [name, config] of Object.entries(serversData)) {
            const saved = savedPositions[`server:${name}`];
            serverCards.push({
              name,
              role: (config['role'] as string) ?? 'worker',
              host: config['host'] as string | undefined,
              tags: ((config['tags'] ?? []) as string[]),
              x: saved?.x ?? 550,
              y: saved?.y ?? 30 + idx * 140,
            });
            idx++;
          }
          this.servers.set(serverCards);

          // Parse connections from placement constraints
          const conns: Connection[] = [];
          const servicesWithConstraints = new Set<string>();
          if (compose.compose?.services) {
            for (const [name, svc] of Object.entries(compose.compose.services)) {
              const constraints = svc.deploy?.placement?.constraints ?? [];
              for (const c of constraints) {
                const match = c.match(/node\.(hostname|role)\s*==\s*(.+)/);
                if (match) {
                  servicesWithConstraints.add(name);
                  const type = match[1] as 'hostname' | 'role';
                  const value = match[2].trim();
                  // For hostname constraints, the value maps to a server name
                  if (type === 'hostname') {
                    conns.push({
                      serviceName: name,
                      serverName: value,
                      constraintType: 'hostname',
                      constraintValue: value,
                    });
                  } else {
                    // For role constraints, find servers matching the role
                    for (const srv of serverCards) {
                      if (srv.role === value) {
                        conns.push({
                          serviceName: name,
                          serverName: srv.name,
                          constraintType: 'role',
                          constraintValue: value,
                        });
                      }
                    }
                  }
                }
              }
            }

            // Services without constraints can run on any node
            for (const [name] of Object.entries(compose.compose.services)) {
              if (!servicesWithConstraints.has(name)) {
                for (const srv of serverCards) {
                  conns.push({
                    serviceName: name,
                    serverName: srv.name,
                    constraintType: 'role',
                    constraintValue: 'any',
                    implicit: true,
                  });
                }
              }
            }
          }
          this.connections.set(conns);

          this.loading.set(false);
          this.dirty.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.error.set(err.error?.error || 'Failed to load topology data');
        },
      });
  }

  // ── Drag & Drop: Card movement ──────────────────────────────────────────

  onCardMouseDown(event: MouseEvent, name: string, cardType: 'service' | 'server') {
    if ((event.target as HTMLElement).closest('.topology-card__port')) return;
    event.preventDefault();

    const card = cardType === 'service'
      ? this.services().find(s => s.name === name)
      : this.servers().find(s => s.name === name);
    if (!card) return;

    const canvasRect = this.canvasRef.nativeElement.getBoundingClientRect();
    const scrollLeft = this.canvasRef.nativeElement.parentElement?.scrollLeft ?? 0;
    const scrollTop = this.canvasRef.nativeElement.parentElement?.scrollTop ?? 0;
    const mouseCanvasX = event.clientX - canvasRect.left + scrollLeft;
    const mouseCanvasY = event.clientY - canvasRect.top + scrollTop;

    this.dragState = {
      type: 'card',
      target: name,
      cardType,
      offsetX: mouseCanvasX - card.x,
      offsetY: mouseCanvasY - card.y,
      startX: 0,
      startY: 0,
    };

    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
  }

  // ── Drag & Drop: Connection creation ────────────────────────────────────

  onPortMouseDown(event: MouseEvent, serviceName: string) {
    event.preventDefault();
    event.stopPropagation();

    const svc = this.services().find(s => s.name === serviceName);
    if (!svc) return;

    const x1 = svc.x + CARD_WIDTH;
    const y1 = svc.y + CARD_HEIGHT / 2;

    this.dragState = {
      type: 'connection',
      target: serviceName,
      offsetX: 0,
      offsetY: 0,
      startX: x1,
      startY: y1,
    };
    this.pendingServiceName.set(serviceName);
    this.pendingLine.set({ x1, y1, x2: event.clientX, y2: event.clientY });

    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
  }

  private onMouseMove(event: MouseEvent) {
    if (!this.dragState) return;

    const canvasRect = this.canvasRef?.nativeElement?.getBoundingClientRect();
    if (!canvasRect) return;
    const scrollLeft = this.canvasRef.nativeElement.parentElement?.scrollLeft ?? 0;
    const scrollTop = this.canvasRef.nativeElement.parentElement?.scrollTop ?? 0;
    const mouseCanvasX = event.clientX - canvasRect.left + scrollLeft;
    const mouseCanvasY = event.clientY - canvasRect.top + scrollTop;

    if (this.dragState.type === 'card') {
      const newX = Math.max(0, mouseCanvasX - this.dragState.offsetX);
      const newY = Math.max(0, mouseCanvasY - this.dragState.offsetY);

      if (this.dragState.cardType === 'service') {
        this.services.update(s => s.map(svc =>
          svc.name === this.dragState!.target ? { ...svc, x: newX, y: newY } : svc
        ));
      } else {
        this.servers.update(s => s.map(srv =>
          srv.name === this.dragState!.target ? { ...srv, x: newX, y: newY } : srv
        ));
      }
    } else if (this.dragState.type === 'connection') {
      this.pendingLine.update(l => l ? { ...l, x2: mouseCanvasX, y2: mouseCanvasY } : null);
    }
  }

  private onMouseUp(event: MouseEvent) {
    if (this.dragState?.type === 'card') {
      this.savePositions();
    } else if (this.dragState?.type === 'connection') {
      // Check if mouse is over a server card
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const serverCard = el?.closest('[data-server-name]') as HTMLElement | null;
      if (serverCard) {
        const serverName = serverCard.getAttribute('data-server-name');
        const serviceName = this.dragState.target;
        if (serverName && serviceName) {
          // Check if explicit connection already exists
          const exists = this.connections().some(
            c => c.serviceName === serviceName && c.serverName === serverName && !c.implicit
          );
          if (!exists) {
            // Remove implicit connections for this service (it now has explicit ones)
            this.connections.update(c => [
              ...c.filter(x => !(x.serviceName === serviceName && x.implicit)),
              {
                serviceName,
                serverName,
                constraintType: 'hostname' as const,
                constraintValue: serverName,
              },
            ]);
            this.dirty.set(true);
          }
        }
      }
      this.pendingLine.set(null);
      this.pendingServiceName.set(null);
    }

    this.dragState = null;
    document.removeEventListener('mousemove', this.boundMouseMove);
    document.removeEventListener('mouseup', this.boundMouseUp);
  }

  // ── Connection management ──────────────────────────────────────────────

  removeConnection(conn: Connection) {
    if (conn.implicit) return;
    this.connections.update(c => c.filter(
      x => !(x.serviceName === conn.serviceName && x.serverName === conn.serverName)
    ));
    this.dirty.set(true);
  }

  // ── Auto Layout ────────────────────────────────────────────────────────

  autoLayout() {
    this.services.update(svcs => svcs.map((svc, i) => ({
      ...svc,
      x: 50,
      y: 30 + i * 140,
    })));
    this.servers.update(srvs => srvs.map((srv, i) => ({
      ...srv,
      x: 550,
      y: 30 + i * 140,
    })));
    this.savePositions();
  }

  // ── Save ───────────────────────────────────────────────────────────────

  save() {
    if (!this.compose || !this.dirty()) return;

    this.confirmService.confirm({
      message: 'Save topology changes to docker-compose.yml? This will update placement constraints.',
      header: 'Confirm Save',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Save',
      rejectLabel: 'Cancel',
      accept: () => this.doSave(),
    });
  }

  private doSave() {
    this.saving.set(true);

    // Re-fetch compose to get latest version, then apply our connections
    this.apiService.getCompose()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (!response.compose) {
            this.saving.set(false);
            this.messageService.add({
              severity: 'error',
              summary: 'Error',
              detail: 'No docker-compose.yml found',
            });
            return;
          }

          const compose = response.compose;
          const conns = this.connections().filter(c => !c.implicit);

          // Update placement constraints for each service
          for (const [name, svc] of Object.entries(compose.services)) {
            const serviceConns = conns.filter(c => c.serviceName === name);
            if (serviceConns.length > 0) {
              if (!svc.deploy) svc.deploy = {};
              if (!svc.deploy.placement) svc.deploy.placement = {};
              svc.deploy.placement.constraints = serviceConns.map(c =>
                `node.${c.constraintType}==${c.constraintValue}`
              );
            } else {
              // Remove constraints if no connections
              if (svc.deploy?.placement?.constraints) {
                delete svc.deploy.placement.constraints;
                if (Object.keys(svc.deploy.placement).length === 0) {
                  delete svc.deploy.placement;
                }
                if (Object.keys(svc.deploy).length === 0) {
                  delete svc.deploy;
                }
              }
            }
          }

          this.apiService.updateCompose(compose)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: () => {
                this.saving.set(false);
                this.dirty.set(false);
                this.compose = compose;
                this.messageService.add({
                  severity: 'success',
                  summary: 'Saved',
                  detail: 'Topology saved to docker-compose.yml',
                });
              },
              error: (err) => {
                this.saving.set(false);
                this.messageService.add({
                  severity: 'error',
                  summary: 'Error',
                  detail: err.error?.error || 'Failed to update docker-compose.yml',
                });
              },
            });
        },
        error: (err) => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: err.error?.error || 'Failed to read docker-compose.yml',
          });
        },
      });
  }

  // ── Positions persistence ──────────────────────────────────────────────

  private savePositions() {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const svc of this.services()) {
      positions[`service:${svc.name}`] = { x: svc.x, y: svc.y };
    }
    for (const srv of this.servers()) {
      positions[`server:${srv.name}`] = { x: srv.x, y: srv.y };
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
    } catch { /* ignore */ }
  }

  private loadPositions(): Record<string, { x: number; y: number }> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  getServicePortX(svc: ServiceCard): number {
    return svc.x + CARD_WIDTH;
  }

  getServicePortY(svc: ServiceCard): number {
    return svc.y + CARD_HEIGHT / 2;
  }

  getServerPortX(srv: ServerCard): number {
    return srv.x;
  }

  getServerPortY(srv: ServerCard): number {
    return srv.y + CARD_HEIGHT / 2;
  }
}
