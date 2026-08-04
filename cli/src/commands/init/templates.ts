import nunjucks from 'nunjucks';
import configYml from './templates/config.yml' with { type: 'file' };
import serversYml from './templates/servers.yml' with { type: 'file' };
import dockerComposeYml from './templates/docker-compose.yml' with { type: 'file' };
import githubBuildYml from './templates/github-build.yml' with { type: 'file' };
import githubDeployYml from './templates/github-deploy.yml' with { type: 'file' };
import gitlabBuildYml from './templates/gitlab-build.yml' with { type: 'file' };
import gitlabDeployYml from './templates/gitlab-deploy.yml' with { type: 'file' };
import bitbucketBuildYml from './templates/bitbucket-build.yml' with { type: 'file' };
import bitbucketDeployYml from './templates/bitbucket-deploy.yml' with { type: 'file' };

// Standard Nunjucks env for project templates (config.yml, servers.yml)
const njk = nunjucks.configure({ autoescape: false, noCache: true });

// Separate env for CI templates — uses [[ ]] to avoid conflict with ${{ }} GitHub Actions syntax
const njkCI = new nunjucks.Environment(undefined, {
  autoescape: false,
  noCache: true,
  tags: { variableStart: '[[', variableEnd: ']]' },
});

// bun build --compile only embeds statically analyzable `with { type: 'file' }` imports.
const TEMPLATE_PATHS: Record<string, string> = {
  'config.yml': configYml,
  'servers.yml': serversYml,
  'docker-compose.yml': dockerComposeYml,
  'github-build.yml': githubBuildYml,
  'github-deploy.yml': githubDeployYml,
  'gitlab-build.yml': gitlabBuildYml,
  'gitlab-deploy.yml': gitlabDeployYml,
  'bitbucket-build.yml': bitbucketBuildYml,
  'bitbucket-deploy.yml': bitbucketDeployYml,
};

export async function loadTemplate(name: string): Promise<string> {
  const path = TEMPLATE_PATHS[name];
  if (!path) {
    throw new Error(`Unknown init template: ${name}`);
  }
  return Bun.file(path).text();
}

export function render(template: string, ctx: Record<string, unknown>): string {
  return njk.renderString(template, ctx);
}

export function renderCI(template: string, ctx: Record<string, unknown>): string {
  return njkCI.renderString(template, ctx);
}
