/**
 * The multinode fixture uploads a file to /srv/e2e-binder on every node (E-44-04, `uploads:` in its
 * config.yml), and every deploy of it checks that destination first. Like any upload destination
 * outside the deploy user's reach, an operator creates it once as root (the deploy's own permission
 * error says so): this does that on the lane's nodes before the first fixture is handed out.
 */

import { DEPLOY_USER } from "../../../helpers/connection";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { nodeExec } from "../../../helpers/k8s";
import { currentTopology } from "../../../helpers/topology";

const UPLOAD_DIR = "/srv/e2e-binder";

let prepared: Promise<void> | null = null;

function prepareUploadDir(): Promise<void> {
  prepared ??= (async () => {
    for (const node of currentTopology().nodes) {
      const result = await nodeExec(node.key, `mkdir -p ${UPLOAD_DIR} && chown ${DEPLOY_USER}: ${UPLOAD_DIR}`);
      if (result.exitCode !== 0) throw new Error(`cannot prepare ${UPLOAD_DIR} on ${node.key}: ${result.stderr.trim()}`);
    }
  })();
  return prepared;
}

export async function multinodeFixture(): Promise<Fixture> {
  await prepareUploadDir();
  return makeFixture("test-app-k3s-multinode", { cluster: "k3s" });
}
