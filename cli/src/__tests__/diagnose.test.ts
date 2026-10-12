import { describe, expect, it } from 'bun:test';
import { analyzeTaskError } from '../commands/app/diagnose';

describe('analyzeTaskError', () => {
  it('names the scheduling reason when no node can take the task', () => {
    expect(analyzeTaskError('no suitable node (scheduling constraints not satisfied on 2 nodes)')).toBe(
      'No node can run the task (scheduling constraints not satisfied on 2 nodes). Check its placement constraints, the node labels and free resources: docker node ls',
    );
  });

  it('points to the registry when the image cannot be pulled', () => {
    for (const error of [
      'No such image: registry.example.com/shop/web:1.2.0',
      'pull access denied for shop/web, repository does not exist or may require docker login',
      'manifest unknown: manifest unknown',
    ]) {
      expect(analyzeTaskError(error)).toMatch(error.startsWith('No such image') ? /not have been pushed/ : /cannot be pulled/);
    }
  });

  it('reads the exit code of a container that stopped', () => {
    expect(analyzeTaskError('task: non-zero exit (1)')).toBe('The container exited with code 1. Read its output with: dockflow logs <env> <service>');
    expect(analyzeTaskError('task: non-zero exit (137)')).toMatch(/killed \(exit 137\)/);
  });

  it('suggests a bind directory to create', () => {
    expect(analyzeTaskError('invalid mount config for type "bind": bind source path does not exist: /srv/shop/uploads')).toBe(
      'Create the directory on the server: mkdir -p /srv/shop/uploads',
    );
  });

  it('falls back to the service logs', () => {
    expect(analyzeTaskError('something new')).toBe('Check Docker logs for more details: docker service logs <service_name>');
  });
});
