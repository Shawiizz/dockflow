import { Component, inject, effect, viewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TagModule } from 'primeng/tag';
import { EnvironmentService } from '@core/services/environment.service';
import { OperationStateService } from '@core/services/operation-state.service';

@Component({
  selector: 'app-build',
  standalone: true,
  imports: [CommonModule, FormsModule, TagModule],
  templateUrl: './build.component.html',
  styleUrl: './build.component.scss',
})
export class BuildComponent {
  private opState = inject(OperationStateService);
  envService = inject(EnvironmentService);

  building = this.opState.building;
  buildLogs = this.opState.buildLogs;
  buildSuccess = this.opState.buildSuccess;

  private outputEl = viewChild<ElementRef>('outputContainer');

  constructor() {
    effect(() => {
      this.buildLogs();
      const el = this.outputEl()?.nativeElement;
      if (el) {
        requestAnimationFrame(() => el.scrollTop = el.scrollHeight);
      }
    });
  }

  servicesFilter = '';
  push = false;

  startBuild() {
    const env = this.envService.selectedOrUndefined();
    if (!env) return;

    const body: Record<string, unknown> = { environment: env };
    if (this.servicesFilter.trim()) body['services'] = this.servicesFilter.trim();
    if (this.push) body['push'] = true;

    this.opState.startBuild(body);
  }

  cancelBuild() {
    this.opState.cancelBuild();
  }
}
