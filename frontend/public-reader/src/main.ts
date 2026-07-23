import '@memoza/core/views/styles.css';
import { renderMarkdown } from '@memoza/core/views/markdown';

const data = document.getElementById('page-data');
const host = document.getElementById('content');
if (data?.textContent && host) {
  const page = JSON.parse(data.textContent) as { body: string };
  void renderMarkdown(host, page.body);
}
