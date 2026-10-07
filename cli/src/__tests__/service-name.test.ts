import { describe, expect, it } from 'bun:test';
import { idleServices, unknownServiceError } from '../commands/app/service-name';
import { ErrorCode } from '../utils/errors';

describe('unknownServiceError', () => {
  it('points an accessory to the accessories command', () => {
    const error = unknownServiceError('production', 'shop-production', 'redis', ['web'], true, 'logs');
    expect(error.message).toBe("'redis' is an accessory of production, not a service of the app");
    expect(error.code).toBe(ErrorCode.SERVICE_NOT_FOUND);
    expect(error.suggestion).toBe('Run `dockflow accessories logs production redis`.');
  });

  it('says how accessories change for a command they do not have', () => {
    expect(unknownServiceError('production', 'shop-production', 'redis', ['web'], true, 'scale').suggestion).toBe(
      'Accessories have no scale: change accessories.yml and run `dockflow deploy production --accessories`.',
    );
  });

  it('lists the services of the app for an unknown name', () => {
    const error = unknownServiceError('production', 'shop-production', 'wbe', ['web', 'worker'], false, 'exec');
    expect(error.message).toBe('No service wbe in shop-production');
    expect(error.suggestion).toBe('Services: web, worker');
  });

  it('says nothing is deployed for an empty stack', () => {
    expect(unknownServiceError('production', 'shop-production', 'web', [], false, 'exec')).toMatchObject({
      code: ErrorCode.STACK_NOT_FOUND,
      suggestion: 'Deploy first: `dockflow deploy production`.',
    });
  });
});

describe('idleServices', () => {
  it('names the services a restart leaves stopped because they have 0 replicas', () => {
    const services = [
      { name: 'web', replicas: '2/2' },
      { name: 'worker', replicas: '0/0' },
      { name: 'cron', replicas: '0/1' },
    ];
    expect(idleServices(services, ['web', 'worker', 'cron'])).toEqual(['worker']);
    expect(idleServices(services, ['web'])).toEqual([]);
  });
});
