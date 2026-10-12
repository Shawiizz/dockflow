import { describe, expect, it, spyOn } from 'bun:test';
import { runBuild } from '../commands/build';
import * as Build from '../services/build';
import * as config from '../utils/config';
import * as output from '../utils/output';

describe('runBuild', () => {
  it('has nothing to build for a project that deploys files only', async () => {
    const load = spyOn(config, 'loadConfig').mockReturnValue({ project_name: 'docs', no_services: true } as never);
    const info = spyOn(output, 'printInfo').mockImplementation(() => {});
    const targets = spyOn(Build, 'getBuildTargets');
    try {
      await runBuild('production', {});

      expect(info).toHaveBeenCalledWith('This project deploys files only (no_services): there is nothing to build.');
      expect(targets).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
      info.mockRestore();
      targets.mockRestore();
    }
  });
});
