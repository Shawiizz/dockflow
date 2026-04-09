import { CanDeactivateFn } from '@angular/router';

/**
 * Interface for components that track unsaved changes.
 */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

/**
 * Guard that warns users before navigating away from pages with unsaved changes.
 */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (component.hasUnsavedChanges?.()) {
    return window.confirm(
      'You have unsaved changes. Are you sure you want to leave this page?',
    );
  }
  return true;
};
