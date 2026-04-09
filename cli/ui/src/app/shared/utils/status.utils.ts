type TagSeverity = 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' | undefined;

// ── Server status ────────────────────────────────────────────────────────────

export function serverStatusSeverity(status: string): TagSeverity {
  switch (status) {
    case 'online': return 'success';
    case 'offline': return 'danger';
    case 'error': return 'danger';
    default: return 'secondary';
  }
}

export function serverStatusLabel(status: string): string {
  switch (status) {
    case 'online': return 'Online';
    case 'offline': return 'Offline';
    case 'error': return 'Error';
    default: return 'Unknown';
  }
}

export function serverStatusIcon(status: string): string {
  switch (status) {
    case 'online': return 'pi pi-check-circle';
    case 'offline': return 'pi pi-times-circle';
    case 'error': return 'pi pi-exclamation-triangle';
    default: return 'pi pi-question-circle';
  }
}

export function swarmSeverity(status: string): TagSeverity {
  switch (status) {
    case 'leader': return 'success';
    case 'reachable': return 'info';
    case 'unreachable': return 'danger';
    default: return 'secondary';
  }
}

export function roleSeverity(role: string): TagSeverity {
  return role === 'manager' ? 'info' : 'secondary';
}

// ── Service / accessory state ────────────────────────────────────────────────

export function serviceStateSeverity(state: string | undefined): TagSeverity {
  switch (state) {
    case 'running': return 'success';
    case 'stopped': return 'danger';
    case 'paused': return 'warn';
    case 'error': return 'danger';
    default: return 'secondary';
  }
}

// ── Deploy status ────────────────────────────────────────────────────────────

export function deployStatusSeverity(status: string): TagSeverity {
  switch (status) {
    case 'success': return 'success';
    case 'failed': return 'danger';
    case 'running': return 'info';
    case 'pending': return 'warn';
    default: return 'secondary';
  }
}

export function deployStatusIcon(status: string): string {
  switch (status) {
    case 'success': return 'pi pi-check-circle';
    case 'failed': return 'pi pi-times-circle';
    case 'running': return 'pi pi-spin pi-spinner';
    case 'pending': return 'pi pi-clock';
    default: return 'pi pi-circle';
  }
}

export function deployStatusColorClass(status: string): string {
  switch (status) {
    case 'success': return 'bg-success-muted text-success';
    case 'failed': return 'bg-error-muted text-error';
    case 'running': return 'bg-accent-muted text-accent';
    case 'pending': return 'bg-warning-muted text-warning';
    default: return 'bg-bg-tertiary text-text-muted';
  }
}

// ── Audit action ─────────────────────────────────────────────────────────────

export function auditActionSeverity(action: string): TagSeverity {
  switch (action?.toLowerCase()) {
    case 'deploy': return 'success';
    case 'rollback': return 'warn';
    case 'scale': return 'info';
    case 'stop': case 'error': return 'danger';
    default: return 'secondary';
  }
}
