import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TagModule } from 'primeng/tag';
import { CheckboxModule } from 'primeng/checkbox';
import { ButtonModule } from 'primeng/button';
import type { PruneResult } from '@api-types';

@Component({
  selector: 'app-prune-section',
  standalone: true,
  imports: [FormsModule, TagModule, CheckboxModule, ButtonModule],
  templateUrl: './prune-section.component.html',
  styleUrl: './prune-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PruneSectionComponent {
  pruning = input(false);
  results = input<PruneResult[]>([]);

  prune = output<{ targets: string[]; all: boolean }>();

  pruneContainers = false;
  pruneImages = false;
  pruneVolumes = false;
  pruneNetworks = false;
  pruneAll = false;

  get pruneTargets(): string[] {
    const targets: string[] = [];
    if (this.pruneContainers) targets.push('containers');
    if (this.pruneImages) targets.push('images');
    if (this.pruneVolumes) targets.push('volumes');
    if (this.pruneNetworks) targets.push('networks');
    return targets;
  }

  runPrune() {
    if (this.pruneTargets.length === 0) return;
    this.prune.emit({ targets: this.pruneTargets, all: this.pruneAll });
  }
}
