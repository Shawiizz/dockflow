const BASE_URL = 'https://dockflow.shawiizz.dev';

let cachedIndex: string | null = null;
let cachedFull: string | null = null;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

export async function getIndex(): Promise<string> {
  if (!cachedIndex) cachedIndex = await fetchText(`${BASE_URL}/llms.txt`);
  return cachedIndex;
}

export async function getFull(): Promise<string> {
  if (!cachedFull) cachedFull = await fetchText(`${BASE_URL}/llms-full.txt`);
  return cachedFull;
}

export interface DocSection {
  title: string;
  path: string;
  content: string;
}

export function parseSections(full: string): DocSection[] {
  const sections: DocSection[] = [];
  const parts = full.split(/^---$/m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const headingMatch = trimmed.match(/^#\s+(.+)/m);
    if (!headingMatch) continue;
    const title = headingMatch[1].trim();
    const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
    sections.push({ title, path: slug, content: trimmed });
  }

  return sections;
}
