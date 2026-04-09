import { Component, input, output, signal, ChangeDetectionStrategy, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { ButtonModule } from 'primeng/button';

@Component({
  selector: 'app-search-filter',
  standalone: true,
  imports: [FormsModule, InputTextModule, IconFieldModule, InputIconModule, ButtonModule],
  template: `
    <div class="flex items-center gap-2">
      <p-iconfield class="flex-1">
        <p-inputicon class="pi pi-search" />
        <input
          pInputText
          type="text"
          [placeholder]="placeholder()"
          [ngModel]="query()"
          (ngModelChange)="onInput($event)"
          class="w-full"
          aria-label="Search"
        />
      </p-iconfield>
      @if (query()) {
        <p-button
          icon="pi pi-times"
          severity="secondary"
          [text]="true"
          [rounded]="true"
          size="small"
          (onClick)="clear()"
          ariaLabel="Clear search"
        />
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchFilterComponent implements OnDestroy {
  placeholder = input('Search...');
  search = output<string>();

  query = signal('');
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  onInput(value: string) {
    this.query.set(value);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.search.emit(value), 300);
  }

  clear() {
    this.query.set('');
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.search.emit('');
  }

  ngOnDestroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}
