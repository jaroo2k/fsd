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

const MAX_TASK_LENGTH = 10000;

// A run needs a notion link, a task description, or both. Returns { url, task } or { error }.
function parseRunRequest(input) {
  const rawUrl = typeof input?.url === 'string' ? input.url.trim() : '';
  const task = typeof input?.task === 'string' ? input.task.trim() : '';
  if (!rawUrl && !task) return { error: '노션 링크나 업무 내용을 입력해 주세요.' };
  const url = rawUrl ? parseNotionUrl(rawUrl) : '';
  if (url === null) return { error: '노션 링크가 아닙니다.' };
  if (task.length > MAX_TASK_LENGTH) return { error: `업무 내용은 ${MAX_TASK_LENGTH}자 이내로 입력해 주세요.` };
  return { url, task };
}

// One pass, so a task that happens to contain "{{BRANCH}}" is not filled in again.
const fillTemplate = (template, values) => template.replace(/\{\{(URL|BRANCH|TASK)\}\}/g, (_, key) => values[key]);

// Without a link the task template is used; with both, the task is added after the notion instructions.
function buildPrompt({ notionTemplate, taskTemplate, url, task, branch }) {
  const values = { URL: url, BRANCH: branch, TASK: task };
  if (!url) return fillTemplate(taskTemplate, values);
  const prompt = fillTemplate(notionTemplate, values);
  return task ? `${prompt.trimEnd()}\n\n추가 업무 내용 (노션 페이지의 지시와 함께 수행합니다):\n${task}\n` : prompt;
}

// Host blocks DNS rebinding; Origin blocks other websites posting to localhost.
function isLocalRequest(headers, port, requireOrigin) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(headers.host)) return false;
  if (!requireOrigin) return true;
  return headers.origin === `http://${headers.host}`;
}

// Plain Korean names for tools, so the log reads without knowing Claude Code.
const TOOL_LABELS = {
  Read: '파일 읽기', Write: '파일 만들기', Edit: '파일 고치기', MultiEdit: '파일 여러 곳 고치기', NotebookEdit: '노트북 고치기',
  Bash: '명령 실행', BashOutput: '실행 결과 확인', KillShell: '실행 중지', KillBash: '실행 중지',
  Glob: '파일 찾기', Grep: '파일 내용 검색', LS: '폴더 목록 보기',
  WebFetch: '웹 페이지 읽기', WebSearch: '웹 검색', TodoWrite: '할 일 목록 정리', Task: '보조 작업 맡기기', Agent: '보조 작업 맡기기',
  ToolSearch: '사용할 도구 찾기', Skill: '전용 기능 사용', ExitPlanMode: '계획 확정', Monitor: '진행 상황 지켜보기', TaskStop: '보조 작업 중지',
};
const NOTION_LABELS = {
  'get-block-children': '페이지 내용 읽기', 'patch-block-children': '페이지에 내용 추가', 'retrieve-a-block': '블록 읽기',
  'update-a-block': '블록 고치기', 'delete-a-block': '블록 지우기', 'retrieve-a-page': '페이지 정보 읽기',
  'retrieve-page-markdown': '페이지 내용 읽기', 'update-page-markdown': '페이지 내용 고치기', 'patch-page': '페이지 속성 바꾸기',
  'post-page': '새 페이지 만들기', 'move-page': '페이지 옮기기', 'retrieve-a-page-property': '페이지 속성 읽기', 'post-search': '검색',
  'create-a-comment': '댓글 달기', 'retrieve-a-comment': '댓글 읽기', 'get-self': '연결 계정 확인', 'get-user': '사용자 정보 확인',
  'get-users': '사용자 목록 확인', 'retrieve-a-database': '데이터베이스 정보 읽기', 'retrieve-a-data-source': '데이터베이스 정보 읽기',
  'query-data-source': '데이터베이스 항목 조회', 'create-a-data-source': '데이터베이스 만들기', 'update-a-data-source': '데이터베이스 고치기',
  'list-data-source-templates': '데이터베이스 템플릿 보기',
};

// MCP tools are named mcp__<server>__<tool>. Unknown names are shown as they are.
function toolLabel(name) {
  if (Object.hasOwn(TOOL_LABELS, name)) return TOOL_LABELS[name];
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (!mcp) return name;
  const [, server, tool] = mcp;
  if (server === 'notion') {
    const action = tool.replace(/^API-/, '');
    return `노션 ${Object.hasOwn(NOTION_LABELS, action) ? NOTION_LABELS[action] : '작업'}`;
  }
  return `${server} 연결 기능 (${tool})`;
}

const SYSTEM_LABELS = { init: '작업 환경을 준비했습니다.', compact_boundary: '대화가 길어져 앞부분을 요약했습니다.' };

// Tool names only: tool input/output could contain secrets.
function formatEvent(line) {
  let e;
  try { e = JSON.parse(line); } catch { return line; }
  if (e.type === 'assistant') {
    return (e.message?.content || [])
      .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? `[도구] ${toolLabel(c.name)}` : ''))
      .filter(Boolean).join('\n') || null;
  }
  if (e.type === 'system' && Object.hasOwn(SYSTEM_LABELS, e.subtype)) return SYSTEM_LABELS[e.subtype];
  return null;
}

const STATUS_LABELS = { queued: '대기 중', running: '실행 중', success: '완료', failed: '실패', interrupted: '중단됨' };

const runView = (run) => ({
  ...run,
  statusLabel: STATUS_LABELS[run.status] || run.status,
});

function formatDuration(ms) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}초`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h) return `${h}시간 ${m}분`;
  return m ? `${m}분 ${total % 60}초` : `${total}초`;
}

const MIN_BAR = 0.5;

// Positions are percentages of the whole run. Each step lasts until the next one starts (the last one until the
// run ends), and the time before the first call is its own row, so the rows add up to the total.
function timelineView(run, steps, now = Date.now()) {
  const start = Date.parse(run.started_at);
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  const span = Math.max(end - start, 1);
  const pct = (ms) => Math.min(100, Math.max(0, (ms / span) * 100));
  const bar = (name, from, to, state) => {
    const width = Math.max(pct(to - from), MIN_BAR);
    return { name, state, duration: formatDuration(to - from), left: Math.min(pct(from - start), 100 - width), width };
  };
  const live = run.status === 'running';
  const runState = live ? 'active' : { success: 'done', failed: 'failed' }[run.status] || 'stopped';
  // Clamped and kept in order, so no row is negative or outside the run.
  let last = start;
  const starts = steps.map((s) => (last = Math.min(Math.max(Date.parse(s.started_at) || last, last), Math.max(end, start))));
  const rows = steps.map((s, i) => {
    const from = starts[i];
    if (i + 1 < steps.length) return bar(toolLabel(s.name), from, starts[i + 1], 'done');
    const state = live ? 'active' : s.finished_at ? 'done' : 'stopped';
    return bar(toolLabel(s.name), from, Math.max(end, from), state);
  });
  if (steps.length && starts[0] > start) rows.unshift(bar('시작 준비', start, starts[0], 'done'));
  return { total: bar('전체', start, end, runState), steps: rows };
}

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
  listProjects, parseProjectSettings, parseGroupName, projectView, projectOptions, groupOptions, groupItems, escapeHtml, isValidProject, parseNotionUrl, parseRunRequest, buildPrompt, MAX_TASK_LENGTH, isLocalRequest, formatEvent, runView, extractSummary, parseRunFilter, UNGROUPED, formatDuration, timelineView, toolLabel,
};
