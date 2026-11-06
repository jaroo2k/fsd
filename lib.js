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
const AGENTS = { claude: 'Claude', codex: 'Codex' };

function parseRunRequest(input) {
  const agent = input?.agent ?? 'claude';
  if (!Object.hasOwn(AGENTS, agent)) return { error: '실행 Agent는 Claude나 Codex만 고를 수 있습니다.' };
  const rawUrl = typeof input?.url === 'string' ? input.url.trim() : '';
  const task = typeof input?.task === 'string' ? input.task.trim() : '';
  if (!rawUrl && !task) return { error: '노션 링크나 업무 내용을 입력해 주세요.' };
  const url = rawUrl ? parseNotionUrl(rawUrl) : '';
  if (url === null) return { error: '노션 링크가 아닙니다.' };
  if (task.length > MAX_TASK_LENGTH) return { error: `업무 내용은 ${MAX_TASK_LENGTH}자 이내로 입력해 주세요.` };
  return { url, task, agent };
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

const MASK = '***';
const SECRET_KEY = 'password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential';
const VALUE = `("[^"\\n]*"|'[^'\\n]*'|[^\\s"',;&]+)`;
const keepQuotes = (match, name, value) => name + (/^["']/.test(value) ? value[0] + MASK + value[0] : MASK);
// Pattern based, so it can miss a secret with no telltale name or shape, and can also hide a harmless value.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `-----BEGIN PRIVATE KEY----- ${MASK}`],
  [/\b(?:ntn_|secret_|sk-|sk_live_|sk_test_|rk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{10,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, MASK],
  [/(\bauthorization\s*[:=]\s*["']?(?:bearer|basic|token)?\s*)[^\s"',;]+/gi, `$1${MASK}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // A quoted value is hidden up to its closing quote, so a value with spaces does not leak its tail.
  [new RegExp(`(--(?:${SECRET_KEY})(?:=|\\s+))${VALUE}`, 'gi'), keepQuotes],
  [new RegExp(`(\\b[\\w.-]*(?:${SECRET_KEY})s?["']?\\s*[:=]\\s*)${VALUE}`, 'gi'), keepQuotes],
];

// known: exact secret values this server holds, such as its own notion token.
function maskSecrets(text, known = []) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const value of known) if (typeof value === 'string' && value.length >= 8) out = out.split(value).join(MASK);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const DETAIL_MAX = 40;

// Only Claude's own short description of what a command was for, never the command itself. Other tool input and
// all output stay hidden, since they could contain secrets.
function toolDetail(c) {
  if (c.name !== 'Bash' || !c.input || typeof c.input !== 'object') return '';
  const { description } = c.input;
  if (typeof description !== 'string') return '';
  const line = description.trim().split('\n')[0].trim();
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX)}…` : line;
}

function formatEvent(line) {
  let e;
  try { e = JSON.parse(line); } catch { return line; }
  if (e.type === 'assistant') {
    return (e.message?.content || [])
      .map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type !== 'tool_use') return '';
        const detail = toolDetail(c);
        return `[도구] ${toolLabel(c.name)}${detail ? `: ${detail}` : ''}`;
      })
      .filter(Boolean).join('\n') || null;
  }
  if (e.type === 'system' && Object.hasOwn(SYSTEM_LABELS, e.subtype)) return SYSTEM_LABELS[e.subtype];
  return null;
}

// Back-to-back calls of the same tool become one line with a count and what each call did. Any other line in
// between starts a new group. Self-contained, because the 업무 실행 page runs this same source in the browser.
function groupLog(entries) {
  const out = [];
  let group = null;
  const flush = () => {
    if (!group) return;
    if (group.count === 1) out.push(`[도구] ${group.label}${group.details.length ? `: ${group.details[0]}` : ''}`);
    else out.push(`[도구] ${group.label} ×${group.count}`, ...group.details.map((d) => `  - ${d}`));
    group = null;
  };
  for (const line of entries.flatMap((entry) => entry.split('\n'))) {
    const m = /^\[도구\] (.+?)(?:: (.*))?$/.exec(line);
    if (m && group && group.label === m[1]) {
      group.count += 1;
      if (m[2]) group.details.push(m[2]);
      continue;
    }
    flush();
    if (m) group = { label: m[1], details: m[2] ? [m[2]] : [], count: 1 };
    else out.push(line);
  }
  flush();
  return out;
}

const STATUS_LABELS = { queued: '대기 중', running: '실행 중', success: '완료', failed: '실패', interrupted: '중단됨' };

const runView = (run) => ({
  ...run,
  statusLabel: STATUS_LABELS[run.status] || run.status,
  agentLabel: AGENTS[run.agent] || AGENTS.claude,
});

// Codex item types shown as the Claude tool with the same meaning, so logs and bars read the same for both.
const CODEX_TOOLS = { command_execution: 'Bash', file_change: 'Edit', web_search: 'WebSearch', todo_list: 'TodoWrite' };
const codexTool = (item) => (item.type === 'mcp_tool_call' ? `mcp__${item.server}__${item.tool}` : CODEX_TOOLS[item.type]);

// Turns `codex exec --json` events into Claude stream-json events. Tool input is dropped on purpose: a Codex
// command has no short description, and the command itself could hold a secret.
function codexTranslator() {
  const started = new Set();
  let lastMessage = '';
  const use = (item) => {
    started.add(item.id);
    return { type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: codexTool(item), input: {} }] } };
  };
  return (e) => {
    const item = e.item && typeof e.item === 'object' ? e.item : null;
    if (e.type === 'thread.started') return [{ type: 'system', subtype: 'init' }];
    if (e.type === 'item.started' && item && codexTool(item)) return [use(item)];
    if (e.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      lastMessage = item.text;
      return [{ type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } }];
    }
    if (e.type === 'item.completed' && item && codexTool(item)) {
      // A file change can arrive only as completed; it still gets a (short) bar.
      const events = started.has(item.id) ? [] : [use(item)];
      return [...events, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id }] } }];
    }
    if (e.type === 'turn.completed') return [{ type: 'result', result: lastMessage, is_error: false }];
    if (e.type === 'turn.failed') {
      const message = String(e.error?.message || '알 수 없는 오류');
      return [{ type: 'assistant', message: { content: [{ type: 'text', text: `오류: ${message}` }] } },
        { type: 'result', result: message, is_error: true }];
    }
    if (e.type === 'error' && typeof e.message === 'string') {
      return [{ type: 'assistant', message: { content: [{ type: 'text', text: `오류: ${e.message}` }] } }];
    }
    return [];
  };
}

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
  // Back-to-back calls with the same label become one row spanning all of them, named with the call count.
  const rows = [];
  for (let i = 0; i < steps.length; i += 1) {
    const label = toolLabel(steps[i].name);
    let j = i;
    while (j + 1 < steps.length && toolLabel(steps[j + 1].name) === label) j += 1;
    const name = j > i ? `${label} ×${j - i + 1}` : label;
    const from = starts[i];
    if (j + 1 < steps.length) rows.push(bar(name, from, starts[j + 1], 'done'));
    else {
      const state = live ? 'active' : steps[j].finished_at ? 'done' : 'stopped';
      rows.push(bar(name, from, Math.max(end, from), state));
    }
    i = j;
  }
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
  const pageSize = Number(params.get('pageSize'));
  return { q: (params.get('q') || '').trim(), project: params.get('project') || '', from, to, page: page > 0 ? page : 1,
    pageSize: [10, 20, 50, 100].includes(pageSize) ? pageSize : 20 };
}

module.exports = {
  AGENTS, codexTranslator, listProjects, parseProjectSettings, parseGroupName, projectView, projectOptions, groupOptions, groupItems, escapeHtml, isValidProject, parseNotionUrl, parseRunRequest, buildPrompt, MAX_TASK_LENGTH, isLocalRequest, formatEvent, runView, extractSummary, parseRunFilter, UNGROUPED, formatDuration, timelineView, toolLabel, groupLog, maskSecrets,
};
