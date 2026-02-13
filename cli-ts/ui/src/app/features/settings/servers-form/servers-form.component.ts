import { Component, input, output, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { TagModule } from 'primeng/tag';

interface ServerEntry {
  name: string;
  role: string;
  host: string;
  tags: string[];
  user: string;
  port: number | null;
  env: { key: string; value: string }[];
}

interface ServerErrors {
  name?: string;
  tags?: string;
}

interface EnvTagEntry {
  tag: string;
  vars: { key: string; value: string }[];
}

@Component({
  selector: 'app-servers-form',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    InputTextModule,
    InputNumberModule,
    SelectModule,
    TooltipModule,
    TagModule,
  ],
  templateUrl: './servers-form.component.html',
  styleUrl: './servers-form.component.scss',
})
export class ServersFormComponent {
  data = input<Record<string, unknown> | null>(null);
  dataChange = output<Record<string, unknown>>();
  dirtyChange = output<boolean>();

  defaultUser = signal('dockflow');
  defaultPort = signal(22);
  servers = signal<ServerEntry[]>([]);
  serverErrors = signal<ServerErrors[]>([]);
  envTags = signal<EnvTagEntry[]>([]);
  newTagName = signal('');

  expandedSections = signal<Record<string, boolean>>({
    defaults: true,
    servers: true,
    env: false,
  });

  roleOptions = [
    { label: 'Manager', value: 'manager' },
    { label: 'Worker', value: 'worker' },
  ];

  private originalJson = '';

  constructor() {
    effect(() => {
      const d = this.data();
      if (d) {
        this.loadFromData(d);
        this.originalJson = JSON.stringify(d);
      }
    });
  }

  private loadFromData(d: Record<string, unknown>) {
    const defaults = (d['defaults'] ?? {}) as Record<string, unknown>;
    this.defaultUser.set((defaults['user'] as string) ?? 'dockflow');
    this.defaultPort.set((defaults['port'] as number) ?? 22);

    const servers = (d['servers'] ?? {}) as Record<string, Record<string, unknown>>;
    this.servers.set(
      Object.entries(servers).map(([name, config]) => ({
        name,
        role: (config['role'] as string) ?? 'manager',
        host: (config['host'] as string) ?? '',
        tags: ((config['tags'] ?? []) as string[]).slice(),
        user: (config['user'] as string) ?? '',
        port: (config['port'] as number) ?? null,
        env: Object.entries((config['env'] ?? {}) as Record<string, string>).map(([key, value]) => ({ key, value })),
      }))
    );

    const env = (d['env'] ?? {}) as Record<string, Record<string, string>>;
    this.envTags.set(
      Object.entries(env).map(([tag, vars]) => ({
        tag,
        vars: Object.entries(vars).map(([key, value]) => ({ key, value })),
      }))
    );
  }

  buildData(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (this.defaultUser() !== 'dockflow' || this.defaultPort() !== 22) {
      result['defaults'] = { user: this.defaultUser(), port: this.defaultPort() };
    }

    const servers: Record<string, unknown> = {};
    for (const srv of this.servers()) {
      if (!srv.name) continue;
      const config: Record<string, unknown> = { role: srv.role, tags: srv.tags };
      if (srv.host) config['host'] = srv.host;
      if (srv.user) config['user'] = srv.user;
      if (srv.port) config['port'] = srv.port;
      const envMap: Record<string, string> = {};
      for (const e of srv.env) {
        if (e.key) envMap[e.key] = e.value;
      }
      if (Object.keys(envMap).length > 0) config['env'] = envMap;
      servers[srv.name] = config;
    }
    result['servers'] = servers;

    const envByTag: Record<string, Record<string, string>> = {};
    for (const et of this.envTags()) {
      if (!et.tag) continue;
      const vars: Record<string, string> = {};
      for (const v of et.vars) {
        if (v.key) vars[v.key] = v.value;
      }
      if (Object.keys(vars).length > 0) envByTag[et.tag] = vars;
    }
    if (Object.keys(envByTag).length > 0) result['env'] = envByTag;

    return result;
  }

  onFieldChange() {
    const data = this.buildData();
    if (!this.validate()) return;
    this.dataChange.emit(data);
    this.dirtyChange.emit(JSON.stringify(data) !== this.originalJson);
  }

  private validate(): boolean {
    const errors: ServerErrors[] = this.servers().map(srv => {
      const e: ServerErrors = {};
      if (!srv.name.trim()) e.name = 'Name is required';
      if (srv.tags.length === 0) e.tags = 'At least one tag is required';
      return e;
    });
    this.serverErrors.set(errors);
    return errors.every(e => !e.name && !e.tags);
  }

  toggleSection(section: string) {
    this.expandedSections.update(s => ({ ...s, [section]: !s[section] }));
  }

  isExpanded(section: string): boolean {
    return this.expandedSections()[section] ?? false;
  }

  addServer() {
    this.servers.update(s => [...s, {
      name: '', role: 'manager', host: '', tags: [], user: '', port: null, env: [],
    }]);
    this.validate();
  }

  removeServer(index: number) {
    this.servers.update(s => s.filter((_, i) => i !== index));
    this.onFieldChange();
  }

  updateServer(index: number, field: string, value: unknown) {
    this.servers.update(s => s.map((srv, i) => i === index ? { ...srv, [field]: value } : srv));
    this.onFieldChange();
  }

  addTag(serverIndex: number, tagInput: HTMLInputElement) {
    const tag = tagInput.value.trim().toLowerCase();
    if (!tag) return;
    const srv = this.servers()[serverIndex];
    if (srv.tags.includes(tag)) return;
    this.servers.update(s => s.map((srv, i) =>
      i === serverIndex ? { ...srv, tags: [...srv.tags, tag] } : srv
    ));
    tagInput.value = '';
    this.onFieldChange();
  }

  removeTag(serverIndex: number, tagIndex: number) {
    this.servers.update(s => s.map((srv, i) =>
      i === serverIndex ? { ...srv, tags: srv.tags.filter((_, ti) => ti !== tagIndex) } : srv
    ));
    this.onFieldChange();
  }

  addServerEnv(serverIndex: number) {
    this.servers.update(s => s.map((srv, i) =>
      i === serverIndex ? { ...srv, env: [...srv.env, { key: '', value: '' }] } : srv
    ));
  }

  removeServerEnv(serverIndex: number, envIndex: number) {
    this.servers.update(s => s.map((srv, i) =>
      i === serverIndex ? { ...srv, env: srv.env.filter((_, ei) => ei !== envIndex) } : srv
    ));
    this.onFieldChange();
  }

  updateServerEnv(serverIndex: number, envIndex: number, field: 'key' | 'value', val: string) {
    this.servers.update(s => s.map((srv, i) =>
      i === serverIndex ? {
        ...srv,
        env: srv.env.map((e, ei) => ei === envIndex ? { ...e, [field]: val } : e),
      } : srv
    ));
    this.onFieldChange();
  }

  addEnvTag() {
    const tag = this.newTagName().trim().toLowerCase();
    if (!tag || this.envTags().some(e => e.tag === tag)) return;
    this.envTags.update(t => [...t, { tag, vars: [] }]);
    this.newTagName.set('');
    this.onFieldChange();
  }

  removeEnvTag(index: number) {
    this.envTags.update(t => t.filter((_, i) => i !== index));
    this.onFieldChange();
  }

  addEnvTagVar(tagIndex: number) {
    this.envTags.update(t => t.map((et, i) =>
      i === tagIndex ? { ...et, vars: [...et.vars, { key: '', value: '' }] } : et
    ));
  }

  removeEnvTagVar(tagIndex: number, varIndex: number) {
    this.envTags.update(t => t.map((et, i) =>
      i === tagIndex ? { ...et, vars: et.vars.filter((_, vi) => vi !== varIndex) } : et
    ));
    this.onFieldChange();
  }

  updateEnvTagVar(tagIndex: number, varIndex: number, field: 'key' | 'value', val: string) {
    this.envTags.update(t => t.map((et, i) =>
      i === tagIndex ? {
        ...et,
        vars: et.vars.map((v, vi) => vi === varIndex ? { ...v, [field]: val } : v),
      } : et
    ));
    this.onFieldChange();
  }
}
