import { Component, signal, OnInit, OnDestroy, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SidebarComponent } from './shared/components/sidebar/sidebar.component';
import { HeaderComponent } from './shared/components/header/header.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    ToastModule,
    SidebarComponent,
    HeaderComponent,
  ],
  providers: [MessageService],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  private platformId = inject(PLATFORM_ID);

  sidebarCollapsed = signal(false);
  isMobile = signal(false);
  mobileOpen = signal(false);

  private mobileQuery?: MediaQueryList;
  private mobileListener = (e: MediaQueryListEvent) => {
    this.isMobile.set(e.matches);
    if (!e.matches) {
      this.mobileOpen.set(false);
    }
  };

  ngOnInit() {
    if (isPlatformBrowser(this.platformId)) {
      this.mobileQuery = window.matchMedia('(max-width: 768px)');
      this.isMobile.set(this.mobileQuery.matches);
      this.mobileQuery.addEventListener('change', this.mobileListener);
    }
  }

  ngOnDestroy() {
    this.mobileQuery?.removeEventListener('change', this.mobileListener);
  }

  toggleMobileSidebar() {
    if (this.isMobile()) {
      this.mobileOpen.set(!this.mobileOpen());
    } else {
      this.sidebarCollapsed.set(!this.sidebarCollapsed());
    }
  }
}
