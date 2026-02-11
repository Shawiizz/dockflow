import { Component, input, output, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TextareaModule } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';

interface HealthEndpoint {
  url: string;
  name?: string;
  expected_status?: number;
  method?: string;
  timeout?: number;
  validate_certs?: boolean;
  retries?: number;
  retry_delay?: number;
}

interface TemplateEntry {
  mode: 'string' | 'object';
  value: string;
  src: string;
  dest: string;
}

@Component({
  selector: 'app-config-form',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    InputTextModule,
    InputNumberModule,
    SelectModule,
    ToggleSwitchModule,
    TextareaModule,
    TooltipModule,
  ],
  templateUrl: './config-form.component.html',
  styleUrl: './config-form.component.scss',
})
export class ConfigFormComponent {
  data = input<Record<string, unknown> | null>(null);
  dataChange = output<Record<string, unknown>>();
  dirtyChange = output<boolean>();

  projectName = signal('');

  registryType = signal<string>('local');
  registryUrl = signal('');
  registryUsername = signal('');
  registryPassword = signal('');
  registryNamespace = signal('');
  registryToken = signal('');
  registryEnabled = signal(true);

  remoteBuild = signal(false);
  imageAutoTag = signal(true);
  enableDebugLogs = signal(false);

  keepReleases = signal(3);
  cleanupOnFailure = signal(true);

  healthEnabled = signal(false);
  onFailure = signal('notify');
  startupDelay = signal(10);
  waitForInternal = signal(true);
  endpoints = signal<HealthEndpoint[]>([]);

  hooksEnabled = signal(true);
  hooksTimeout = signal(300);
  preBuild = signal('');
  postBuild = signal('');
  preDeploy = signal('');
  postDeploy = signal('');

  templates = signal<TemplateEntry[]>([]);

  expandedSections = signal<Record<string, boolean>>({
    project: true,
    registry: false,
    options: false,
    stack: false,
    health: false,
    hooks: false,
    templates: false,
  });

  registryTypes = [
    { label: 'Local', value: 'local' },
    { label: 'Docker Hub', value: 'dockerhub' },
    { label: 'GitHub CR', value: 'ghcr' },
    { label: 'GitLab', value: 'gitlab' },
    { label: 'Custom', value: 'custom' },
  ];

  onFailureOptions = [
    { label: 'Notify', value: 'notify' },
    { label: 'Rollback', value: 'rollback' },
    { label: 'Fail', value: 'fail' },
    { label: 'Ignore', value: 'ignore' },
  ];

  httpMethods = [
    { label: 'GET', value: 'GET' },
    { label: 'POST', value: 'POST' },
    { label: 'PUT', value: 'PUT' },
    { label: 'DELETE', value: 'DELETE' },
    { label: 'HEAD', value: 'HEAD' },
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
    this.projectName.set((d['project_name'] as string) ?? '');

    const reg = (d['registry'] ?? {}) as Record<string, unknown>;
    this.registryType.set((reg['type'] as string) ?? 'local');
    this.registryUrl.set((reg['url'] as string) ?? '');
    this.registryUsername.set((reg['username'] as string) ?? '');
    this.registryPassword.set((reg['password'] as string) ?? '');
    this.registryNamespace.set((reg['namespace'] as string) ?? '');
    this.registryToken.set((reg['token'] as string) ?? '');
    this.registryEnabled.set((reg['enabled'] as boolean) ?? true);

    const opts = (d['options'] ?? {}) as Record<string, unknown>;
    this.remoteBuild.set((opts['remote_build'] as boolean) ?? false);
    this.imageAutoTag.set((opts['image_auto_tag'] as boolean) ?? true);
    this.enableDebugLogs.set((opts['enable_debug_logs'] as boolean) ?? false);

    const sm = (d['stack_management'] ?? {}) as Record<string, unknown>;
    this.keepReleases.set((sm['keep_releases'] as number) ?? 3);
    this.cleanupOnFailure.set((sm['cleanup_on_failure'] as boolean) ?? true);

    const hc = (d['health_checks'] ?? {}) as Record<string, unknown>;
    this.healthEnabled.set((hc['enabled'] as boolean) ?? false);
    this.onFailure.set((hc['on_failure'] as string) ?? 'notify');
    this.startupDelay.set((hc['startup_delay'] as number) ?? 10);
    this.waitForInternal.set((hc['wait_for_internal'] as boolean) ?? true);
    this.endpoints.set(((hc['endpoints'] ?? []) as HealthEndpoint[]).map(e => ({ ...e })));

    const hk = (d['hooks'] ?? {}) as Record<string, unknown>;
    this.hooksEnabled.set((hk['enabled'] as boolean) ?? true);
    this.hooksTimeout.set((hk['timeout'] as number) ?? 300);
    this.preBuild.set((hk['pre-build'] as string) ?? '');
    this.postBuild.set((hk['post-build'] as string) ?? '');
    this.preDeploy.set((hk['pre-deploy'] as string) ?? '');
    this.postDeploy.set((hk['post-deploy'] as string) ?? '');

    const tmpl = (d['templates'] ?? []) as (string | { src: string; dest: string })[];
    this.templates.set(tmpl.map(t => {
      if (typeof t === 'string') {
        return { mode: 'string' as const, value: t, src: '', dest: '' };
      }
      return { mode: 'object' as const, value: '', src: t.src, dest: t.dest };
    }));
  }

  buildData(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      project_name: this.projectName(),
    };

    if (this.registryType() !== 'local' || this.registryUrl() || this.registryUsername()) {
      const reg: Record<string, unknown> = { type: this.registryType() };
      if (this.registryUrl()) reg['url'] = this.registryUrl();
      if (this.registryUsername()) reg['username'] = this.registryUsername();
      if (this.registryPassword()) reg['password'] = this.registryPassword();
      if (this.registryNamespace()) reg['namespace'] = this.registryNamespace();
      if (this.registryToken()) reg['token'] = this.registryToken();
      reg['enabled'] = this.registryEnabled();
      result['registry'] = reg;
    }

    result['options'] = {
      remote_build: this.remoteBuild(),
      image_auto_tag: this.imageAutoTag(),
      enable_debug_logs: this.enableDebugLogs(),
    };

    result['stack_management'] = {
      keep_releases: this.keepReleases(),
      cleanup_on_failure: this.cleanupOnFailure(),
    };

    if (this.healthEnabled() || this.endpoints().length > 0) {
      result['health_checks'] = {
        enabled: this.healthEnabled(),
        on_failure: this.onFailure(),
        startup_delay: this.startupDelay(),
        wait_for_internal: this.waitForInternal(),
        endpoints: this.endpoints().map(e => {
          const ep: Record<string, unknown> = { url: e.url };
          if (e.name) ep['name'] = e.name;
          if (e.expected_status && e.expected_status !== 200) ep['expected_status'] = e.expected_status;
          if (e.method && e.method !== 'GET') ep['method'] = e.method;
          if (e.timeout && e.timeout !== 30) ep['timeout'] = e.timeout;
          if (e.validate_certs === false) ep['validate_certs'] = false;
          if (e.retries && e.retries !== 3) ep['retries'] = e.retries;
          if (e.retry_delay && e.retry_delay !== 5) ep['retry_delay'] = e.retry_delay;
          return ep;
        }),
      };
    }

    if (this.preBuild() || this.postBuild() || this.preDeploy() || this.postDeploy()) {
      const hooks: Record<string, unknown> = {
        enabled: this.hooksEnabled(),
        timeout: this.hooksTimeout(),
      };
      if (this.preBuild()) hooks['pre-build'] = this.preBuild();
      if (this.postBuild()) hooks['post-build'] = this.postBuild();
      if (this.preDeploy()) hooks['pre-deploy'] = this.preDeploy();
      if (this.postDeploy()) hooks['post-deploy'] = this.postDeploy();
      result['hooks'] = hooks;
    }

    const tmpls = this.templates()
      .map(t => t.mode === 'string' ? t.value : { src: t.src, dest: t.dest })
      .filter(t => typeof t === 'string' ? t.length > 0 : (t as { src: string }).src.length > 0);
    if (tmpls.length > 0) {
      result['templates'] = tmpls;
    }

    return result;
  }

  onFieldChange() {
    const data = this.buildData();
    this.dataChange.emit(data);
    this.dirtyChange.emit(JSON.stringify(data) !== this.originalJson);
  }

  toggleSection(section: string) {
    this.expandedSections.update(s => ({ ...s, [section]: !s[section] }));
  }

  isExpanded(section: string): boolean {
    return this.expandedSections()[section] ?? false;
  }

  addEndpoint() {
    this.endpoints.update(eps => [...eps, {
      url: '', name: '', expected_status: 200, method: 'GET',
      timeout: 30, retries: 3, retry_delay: 5, validate_certs: true,
    }]);
    this.onFieldChange();
  }

  removeEndpoint(index: number) {
    this.endpoints.update(eps => eps.filter((_, i) => i !== index));
    this.onFieldChange();
  }

  updateEndpoint(index: number, field: string, value: unknown) {
    this.endpoints.update(eps => eps.map((ep, i) => i === index ? { ...ep, [field]: value } : ep));
    this.onFieldChange();
  }

  addTemplate() {
    this.templates.update(t => [...t, { mode: 'string' as const, value: '', src: '', dest: '' }]);
    this.onFieldChange();
  }

  removeTemplate(index: number) {
    this.templates.update(t => t.filter((_, i) => i !== index));
    this.onFieldChange();
  }

  updateTemplate(index: number, updates: Partial<TemplateEntry>) {
    this.templates.update(t => t.map((tmpl, i) => i === index ? { ...tmpl, ...updates } : tmpl));
    this.onFieldChange();
  }
}
