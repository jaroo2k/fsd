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

const UNGROUPED = '미분류';
const MAX_SETTING_LENGTH = 50;

// Returns the cleaned settings, or null when any row is invalid so nothing gets saved.
function parseProjectSettings(input, names, groups) {
  if (!Array.isArray(input)) return null;
  const settings = [];
  for (const row of input) {
    if (!names.includes(row?.name) || typeof row.alias !== 'string' || typeof row.group !== 'string') return null;
    const alias = row.alias.trim();
    const group = row.group.trim();
    if (alias.length > MAX_SETTING_LENGTH || group.length > MAX_SETTING_LENGTH) return null;
    const groupName = group === UNGROUPED ? '' : group;
    if (groupName && !groups.includes(groupName)) return null;
    settings.push({ name: row.name, alias, group: groupName });
  }
  return settings;
}

// Returns the cleaned name, or null when it can't be a group. UNGROUPED is the "no group" label.
function parseGroupName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= MAX_SETTING_LENGTH && name !== UNGROUPED ? name : null;
}

// Folders are the source of truth: settings of a removed folder are simply not shown.
function projectView(names, settings, groups) {
  const byName = new Map(settings.map((s) => [s.name, s]));
  const rows = names.map((name) => ({
    name,
    alias: byName.get(name)?.alias || '',
    group: byName.get(name)?.group_name || '',
  }));
  return { rows, groups: [...groups].sort((a, b) => a.localeCompare(b)) };
}

function projectOptions({ rows, groups }, emptyLabel = '선택하세요') {
  const options = (group) => rows.filter((r) => r.group === group)
    .map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.alias || r.name)}</option>`).join('');
  const optgroup = (label, group) => {
    const inner = options(group);
    return inner && `<optgroup label="${escapeHtml(label)}">${inner}</optgroup>`;
  };
  return `<option value="">${escapeHtml(emptyLabel)}</option>${groups.map((g) => optgroup(g, g)).join('')}${optgroup(UNGROUPED, '')}`;
}

function groupOptions(groups, selected = '') {
  const option = (value, label) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  return option('', UNGROUPED) + groups.map((g) => option(g, g)).join('');
}

const groupItems = (groups) => groups.map((g) => `<li data-group="${escapeHtml(g)}"><span>${escapeHtml(g)}</span><button type="button" class="secondary" aria-label="${escapeHtml(g)} 삭제">삭제</button></li>`).join('');

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

const STATUS_LABELS = { queued: '대기 중', running: '실행 중', success: '완료', failed: '실패', interrupted: '중단됨' };

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
  return { q: (params.get('q') || '').trim(), project: params.get('project') || '', from, to, page: page > 0 ? page : 1 };
}

module.exports = {
  listProjects, parseProjectSettings, parseGroupName, projectView, projectOptions, groupOptions, groupItems, escapeHtml, isValidProject, parseNotionUrl, isLocalRequest, formatEvent, runView, extractSummary, parseRunFilter, UNGROUPED,
};
