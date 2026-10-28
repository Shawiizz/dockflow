import { docsLlms } from '@/lib/source';
import { appName, description } from '@/lib/shared';

export const revalidate = false;

export async function GET() {
  const index = (await docsLlms.index())
    .replace(/^# Docs\n/, `# ${appName}\n\n> ${description}\n`)
    // the pages are served with a trailing slash
    .replace(/\]\((\/[^)#]*[^/)])\)/g, ']($1/)');
  return new Response(index);
}
