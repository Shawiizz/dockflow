import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, catchError, of, map } from 'rxjs';
import type {
  HealthResponse,
  ServerStatus,
  ServersResponse,
  ProjectInfo,
  ConnectionInfo,
  ConfigResponse,
  ServersConfigResponse,
  ConfigUpdateResponse,
  ServersConfigUpdateResponse,
  RawConfigResponse,
  ServicesListResponse,
  LogsResponse,
  DeployHistoryResponse,
  AccessoriesResponse,
  ServiceActionResponse,
  AccessoriesStatusResponse,
  AccessoryActionResponse,
  OperationStatusResponse,
  PruneRequest,
  PruneResponse,
  DiskUsageResponse,
  LockInfo,
  LockActionResponse,
  ContainerStatsResponse,
  AuditResponse,
} from '@api-types';

// Re-export types for consumers
export type {
  ServerStatus,
  ServersResponse,
  ProjectInfo,
  ConnectionInfo,
  ConfigResponse,
  ServersConfigResponse,
  ConfigUpdateResponse,
  RawConfigResponse,
  ServiceInfo,
  ServiceState,
  ServicesListResponse,
  LogEntry,
  LogsResponse,
  DeployHistoryEntry,
  DeployHistoryResponse,
  DeployStatus,
  DeployTarget,
  AccessoryInfo,
  AccessoriesResponse,
  ServiceActionResponse,
  AccessoryStatusInfo,
  AccessoriesStatusResponse,
  AccessoryActionResponse,
  OperationStatusResponse,
  PruneRequest,
  PruneResult,
  PruneResponse,
  DiskUsageResponse,
  LockInfo,
  LockActionResponse,
  ContainerStatsEntry,
  ContainerStatsResponse,
  AuditEntry,
  AuditResponse,
} from '@api-types';

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  private http = inject(HttpClient);
  private baseUrl = '/api';

  // ── Health ───────────────────────────────────────────────────────────────

  getHealth(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(`${this.baseUrl}/health`);
  }

  // ── Project ──────────────────────────────────────────────────────────────

  getProjectInfo(): Observable<ProjectInfo> {
    return this.http.get<ProjectInfo>(`${this.baseUrl}/project`);
  }

  getConnectionInfo(): Observable<ConnectionInfo> {
    return this.http.get<ConnectionInfo>(`${this.baseUrl}/project/connection`);
  }

  // ── Servers ──────────────────────────────────────────────────────────────

  getServers(env?: string): Observable<ServersResponse> {
    let params = new HttpParams();
    if (env) {
      params = params.set('env', env);
    }
    return this.http.get<ServersResponse>(`${this.baseUrl}/servers`, { params }).pipe(
      catchError(() => of({ servers: [], environments: [], total: 0 }))
    );
  }

  getServerStatus(serverName: string, env?: string): Observable<ServerStatus> {
    let params = new HttpParams();
    if (env) {
      params = params.set('env', env);
    }
    return this.http.get<ServerStatus>(
      `${this.baseUrl}/servers/${serverName}/status`,
      { params }
    );
  }

  getEnvironments(): Observable<string[]> {
    return this.http.get<{ environments: string[] }>(`${this.baseUrl}/servers/environments`).pipe(
      map(res => res.environments),
      catchError(() => of([]))
    );
  }

  // ── Config ───────────────────────────────────────────────────────────────

  getConfig(): Observable<ConfigResponse> {
    return this.http.get<ConfigResponse>(`${this.baseUrl}/config`);
  }

  getServersConfig(): Observable<ServersConfigResponse> {
    return this.http.get<ServersConfigResponse>(`${this.baseUrl}/config/servers`);
  }

  updateConfig(config: Record<string, unknown>): Observable<ConfigUpdateResponse> {
    return this.http.put<ConfigUpdateResponse>(`${this.baseUrl}/config`, config);
  }

  updateServersConfig(servers: Record<string, unknown>): Observable<ServersConfigUpdateResponse> {
    return this.http.put<ServersConfigUpdateResponse>(`${this.baseUrl}/config/servers`, servers);
  }

  getRawConfig(fileName: string): Observable<RawConfigResponse> {
    return this.http.get<RawConfigResponse>(`${this.baseUrl}/config/raw/${fileName}`);
  }

  saveRawConfig(fileName: string, content: string): Observable<{ success: boolean }> {
    return this.http.put<{ success: boolean }>(`${this.baseUrl}/config/raw/${fileName}`, { content });
  }

  // ── Services ─────────────────────────────────────────────────────────────

  getServices(env?: string): Observable<ServicesListResponse> {
    let params = new HttpParams();
    if (env) {
      params = params.set('env', env);
    }
    return this.http.get<ServicesListResponse>(`${this.baseUrl}/services`, { params });
  }

  restartService(name: string, env?: string): Observable<ServiceActionResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.post<ServiceActionResponse>(`${this.baseUrl}/services/${name}/restart`, {}, { params });
  }

  stopService(name: string, env?: string): Observable<ServiceActionResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.post<ServiceActionResponse>(`${this.baseUrl}/services/${name}/stop`, {}, { params });
  }

  scaleService(name: string, replicas: number, env?: string): Observable<ServiceActionResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.post<ServiceActionResponse>(`${this.baseUrl}/services/${name}/scale`, { replicas }, { params });
  }

  rollbackService(name: string, env?: string): Observable<ServiceActionResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.post<ServiceActionResponse>(`${this.baseUrl}/services/${name}/rollback`, {}, { params });
  }

  // ── Logs ─────────────────────────────────────────────────────────────────

  getServiceLogs(serviceName: string, lines = 100, env?: string): Observable<LogsResponse> {
    let params = new HttpParams().set('lines', lines.toString());
    if (env) {
      params = params.set('env', env);
    }
    return this.http.get<LogsResponse>(`${this.baseUrl}/services/${serviceName}/logs`, { params });
  }

  // ── Deploy ───────────────────────────────────────────────────────────────

  getDeployHistory(env?: string): Observable<DeployHistoryResponse> {
    let params = new HttpParams();
    if (env) {
      params = params.set('env', env);
    }
    return this.http.get<DeployHistoryResponse>(`${this.baseUrl}/deploy/history`, { params }).pipe(
      catchError(() => of({ deployments: [], total: 0 }))
    );
  }

  // ── Operations (Deploy/Build streaming) ────────────────────────────────

  getOperationStatus(): Observable<OperationStatusResponse> {
    return this.http.get<OperationStatusResponse>(`${this.baseUrl}/operations/status`);
  }

  cancelOperation(): Observable<{ success: boolean; message: string }> {
    return this.http.post<{ success: boolean; message: string }>(`${this.baseUrl}/operations/cancel`, {});
  }

  // ── Accessories ──────────────────────────────────────────────────────────

  getAccessories(): Observable<AccessoriesResponse> {
    return this.http.get<AccessoriesResponse>(`${this.baseUrl}/accessories`).pipe(
      catchError(() => of({ accessories: [], total: 0 }))
    );
  }

  getAccessoriesStatus(env?: string): Observable<AccessoriesStatusResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.get<AccessoriesStatusResponse>(`${this.baseUrl}/accessories/status`, { params });
  }

  restartAccessory(name: string, env?: string): Observable<AccessoryActionResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.post<AccessoryActionResponse>(`${this.baseUrl}/accessories/${name}/restart`, {}, { params });
  }

  stopAccessory(name: string, env?: string): Observable<AccessoryActionResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.post<AccessoryActionResponse>(`${this.baseUrl}/accessories/${name}/stop`, {}, { params });
  }

  getAccessoryLogs(name: string, lines = 100, env?: string): Observable<LogsResponse> {
    let params = new HttpParams().set('lines', lines.toString());
    if (env) params = params.set('env', env);
    return this.http.get<LogsResponse>(`${this.baseUrl}/accessories/${name}/logs`, { params });
  }

  // ── Resources ────────────────────────────────────────────────────────────

  pruneResources(body: PruneRequest, env?: string): Observable<PruneResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.post<PruneResponse>(`${this.baseUrl}/resources/prune`, body, { params });
  }

  getDiskUsage(env?: string): Observable<DiskUsageResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.get<DiskUsageResponse>(`${this.baseUrl}/resources/disk`, { params });
  }

  // ── Locks ────────────────────────────────────────────────────────────────

  getLockStatus(env: string): Observable<LockInfo> {
    return this.http.get<LockInfo>(`${this.baseUrl}/locks/${encodeURIComponent(env)}`);
  }

  acquireLock(env: string, message?: string): Observable<LockActionResponse> {
    return this.http.post<LockActionResponse>(
      `${this.baseUrl}/locks/${encodeURIComponent(env)}`,
      message ? { message } : {}
    );
  }

  releaseLock(env: string): Observable<LockActionResponse> {
    return this.http.delete<LockActionResponse>(`${this.baseUrl}/locks/${encodeURIComponent(env)}`);
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  getContainerStats(env?: string): Observable<ContainerStatsResponse> {
    let params = new HttpParams();
    if (env) params = params.set('env', env);
    return this.http.get<ContainerStatsResponse>(`${this.baseUrl}/metrics/stats`, { params });
  }

  getAuditLog(lines = 100, env?: string): Observable<AuditResponse> {
    let params = new HttpParams().set('lines', lines.toString());
    if (env) params = params.set('env', env);
    return this.http.get<AuditResponse>(`${this.baseUrl}/metrics/audit`, { params });
  }
}
