// The stack Namespace (DESIGN-CORE 5.5, design-03 5.2): not part of any artifact; the apply engine
// and the release store apply it before the first object of the stack. The `P/stack-name`
// annotation is what the ownership guard compares, so a foreign namespace with the same
// (hash-truncated) name is never adopted. No Pod Security Admission labels in v1 (C8): bind mounts
// and host ports would need `privileged` anyway.

import type { StackRef } from '../../interfaces';
import { ANNOTATIONS } from '../constants';
import { namespaceLabels } from '../labels';
import { namespaceFor } from '../naming';
import type { Namespace } from '../resources/core';

export function namespaceObject(ref: Pick<StackRef, 'project' | 'env'>): Namespace {
  const namespace = namespaceFor(ref.project, ref.env);
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: namespace,
      labels: namespaceLabels({ project: ref.project, namespace }),
      annotations: { [ANNOTATIONS.stackName]: `${ref.project}-${ref.env}` },
    },
  };
}
