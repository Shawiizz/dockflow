import {
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  RouteReuseStrategy,
} from '@angular/router';

/**
 * Keeps all route components alive in memory instead of destroying them.
 * Navigating back to a page restores its exact state (scroll, form inputs, data)
 * without re-fetching anything.
 */
export class KeepAliveRouteStrategy implements RouteReuseStrategy {
  private cache = new Map<string, DetachedRouteHandle>();

  private getKey(route: ActivatedRouteSnapshot): string {
    return route.routeConfig?.path ?? '';
  }

  // Should we detach (save) this route when leaving?
  shouldDetach(_route: ActivatedRouteSnapshot): boolean {
    return true;
  }

  // Store the detached route handle
  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    if (handle) {
      this.cache.set(this.getKey(route), handle);
    }
  }

  // Should we reattach (restore) a previously stored route?
  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    return this.cache.has(this.getKey(route));
  }

  // Retrieve the stored route handle
  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    return this.cache.get(this.getKey(route)) ?? null;
  }

  // Should we reuse the current route? (same route = yes)
  shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    curr: ActivatedRouteSnapshot,
  ): boolean {
    return future.routeConfig === curr.routeConfig;
  }
}
