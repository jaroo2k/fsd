const fs = require('node:fs');

function listProjects(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
}

// Exact match against real directory names, so "..\x" and absolute paths can never pass.
function isValidProject(name, root) {
  return typeof name === 'string' && listProjects(root).includes(name);
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function parseNotionUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const ok = url.protocol === 'https:' && !url.username && !url.password
    && (['notion.so', 'www.notion.so', 'app.notion.com'].includes(host) || host.endsWith('.notion.site'));
  return ok ? url.href : null;
}

// Host blocks DNS rebinding; Origin blocks other websites posting to localhost.
function isLocalRequest(headers, port, requireOrigin) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(headers.host)) return false;
  if (!requireOrigin) return true;
  return headers.origin === `http://${headers.host}`;
}

// Tool names only: tool input/output could contain secrets.
function formatEvent(line) {
  let e;
  try { e = JSON.parse(line); } catch { return line; }
  if (e.type === 'assistant') {
    return (e.message?.content || [])
      .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? `[도구] ${c.name}` : ''))
      .filter(Boolean).join('\n') || null;
  }
  return null;
}

const STATUS_LABELS = { running: '실행 중', success: '완료', failed: '실패', interrupted: '중단됨' };

const runView = (run) => ({
  ...run,
  statusLabel: STATUS_LABELS[run.status] || run.status,
});

const SUMMARY_MAX = 100;

// prompt.md asks for a "작업 요약: ..." line. The last one wins, since earlier text may quote the format.
function extractSummary(text) {
  if (typeof text !== 'string') return null;
  const matches = [...text.matchAll(/^[ \t*_#>-]*작업 요약[ \t]*[:：][ \t*_`]*(.*?)[ \t*_`]*$/gm)];
  const summary = matches.at(-1)?.[1];
  return summary ? summary.slice(0, SUMMARY_MAX) : null;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Returns null for a bad time bound. started_at is compared as text, so only its exact format may pass.
function parseRunFilter(params) {
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  if ((from && !ISO_TIME.test(from)) || (to && !ISO_TIME.test(to))) return null;
  const page = Number.parseInt(params.get('page'), 10);
  return { q: (params.get('q') || '').trim(), from, to, page: page > 0 ? page : 1 };
}

module.exports = {
  listProjects, escapeHtml, isValidProject, parseNotionUrl, isLocalRequest, formatEvent, runView, extractSummary, parseRunFilter,
};
