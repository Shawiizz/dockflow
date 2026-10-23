import { describe, expect, it } from 'bun:test';
import { dockerQueryError } from '../services/swarm/docker';
import { ErrorCode } from '../utils/errors';

const failed = (stderr: string, exitCode = 1) => ({ stdout: '', stderr, exitCode });

describe('dockerQueryError', () => {
  it('says Docker is not running instead of "no services"', () => {
    const error = dockerQueryError('10.0.0.1', failed('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'), 'docker stack services');
    expect(error.message).toBe('Docker is not running on 10.0.0.1');
    expect(error.code).toBe(ErrorCode.DOCKER_NOT_AVAILABLE);
  });

  it('names a missing docker, a node that is not a manager, and a user without access', () => {
    expect(dockerQueryError('h', failed('bash: docker: command not found', 127), 'q').message).toBe('Docker is not installed on h');
    expect(dockerQueryError('h', failed('Error response from daemon: This node is not a swarm manager.'), 'q').message).toBe('h is not a Swarm manager');
    expect(dockerQueryError('h', failed('permission denied while trying to connect to the Docker daemon socket'), 'q').message).toBe(
      'The SSH user of h is not allowed to use Docker',
    );
  });

  it('keeps the first line of any other failure', () => {
    expect(dockerQueryError('h', failed('\nError: something odd\nmore'), 'docker ps').message).toBe('docker ps failed on h: Error: something odd');
  });
});
