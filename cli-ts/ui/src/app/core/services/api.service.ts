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
    return this.http.get<ServicesListResponse>(`${this.baseUrl}/services`, { params }).pipe(
      catchError(() => of({ services: [], stackName: '', total: 0 }))
    );
  }

  // ── Logs ─────────────────────────────────────────────────────────────────

  getServiceLogs(serviceName: string, env?: string, lines = 100): Observable<LogsResponse> {
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

  // ── Accessories ──────────────────────────────────────────────────────────

  getAccessories(): Observable<AccessoriesResponse> {
    return this.http.get<AccessoriesResponse>(`${this.baseUrl}/accessories`).pipe(
      catchError(() => of({ accessories: [], total: 0 }))
    );
  }
}
