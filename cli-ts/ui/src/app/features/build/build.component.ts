import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { ButtonModule } from 'primeng/button';
import { EnvironmentService } from '@core/services/environment.service';
import { OperationStateService } from '@core/services/operation-state.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { TerminalOutputComponent } from '@shared/components/terminal-output/terminal-output.component';

@Component({
  selector: 'app-build',
  standalone: true,
  imports: [FormsModule, TagModule, InputTextModule, CheckboxModule, ButtonModule, PageHeaderComponent, TerminalOutputComponent],
  templateUrl: './build.component.html',
  styleUrl: './build.component.scss',
})
export class BuildComponent {
  private opState = inject(OperationStateService);
  envService = inject(EnvironmentService);

  building = this.opState.building;
  buildLogs = this.opState.buildLogs;
  buildSuccess = this.opState.buildSuccess;

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
