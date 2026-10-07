/**
 * Interactive choice of a service or of one of its tasks (logs --pick, exec --pick).
 */

import type { SSHKeyConnection } from '../../types';
import { selectPrompt } from '../../utils/prompts';
import { createStackBackend } from '../../services/orchestrator/factory';
import { listSwarmTasks } from '../../services/orchestrator/swarm/swarm-utils';
import { DockerError, ErrorCode } from '../../utils/errors';

export async function pickService(connection: SSHKeyConnection, stackName: string): Promise<string> {
  const services = await createStackBackend(connection).getServices(stackName);
  if (services.length === 0) throw new DockerError(`No services found for stack ${stackName}`, { code: ErrorCode.STACK_NOT_FOUND });
  if (services.length === 1) return services[0].name;

  return selectPrompt({
    message: 'Pick a service:',
    options: services.map(s => ({ value: s.name, label: s.name })),
  });
}

export async function pickSwarmTask(stackName: string, service: string, connection: SSHKeyConnection): Promise<string> {
  const tasks = await listSwarmTasks(stackName, service, connection);
  if (tasks.length === 0) throw new DockerError(`No tasks found for service ${service}`, { code: ErrorCode.CONTAINER_NOT_FOUND });

  const options = tasks.map(t => ({
    value: t.id,
    label: `replica ${t.slot} on ${t.node}`,
    hint: t.error ? `${t.currentState} — ${t.error}` : t.currentState,
  }));

  return selectPrompt({ message: 'Pick a task:', options });
}
