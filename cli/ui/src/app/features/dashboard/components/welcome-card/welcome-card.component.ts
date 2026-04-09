import { Component, ChangeDetectionStrategy } from '@angular/core';
@Component({
  selector: 'app-welcome-card',
  standalone: true,
  imports: [],
  templateUrl: './welcome-card.component.html',
  styleUrl: './welcome-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WelcomeCardComponent {}
