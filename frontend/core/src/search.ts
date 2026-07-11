export interface SearchEntry {
  id: string;
  title: string;
  tags: string[];
}

export function search(entries: SearchEntry[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.map(e => e.id);
  return entries
    .filter(e => e.title.toLowerCase().includes(q) || e.tags.some(t => t.toLowerCase().includes(q)))
    .map(e => e.id);
}
