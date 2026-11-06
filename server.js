const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const {
  listProjects, parseProjectSettings, parseGroupName, projectView, projectOptions, groupOptions, groupItems, escapeHtml, isValidProject, parseNotionUrl, isLocalRequest, formatEvent, runView, extractSummary, parseRunFilter, UNGROUPED, timelineView,
} = require('./lib');
const { openDb } = require('./db');

const style = `<style>
:root{color-scheme:light dark;--bg:#f5f6fa;--surface:#fff;--border:#e3e6ee;--text:#1c2130;--muted:#5d6678;
--accent:#4f46e5;--accent-hover:#4338ca;--on-accent:#fff;--field:#fff;--ok:#166534;--err:#b42318;
--running-bg:#e0e7ff;--running:#3730a3;--success-bg:#dcfce7;--success:#166534;--failed-bg:#fee2e2;--failed:#991b1b;
--interrupted-bg:#fef3c7;--interrupted:#92400e;--shadow:0 1px 2px rgb(16 24 40 / .05),0 4px 16px rgb(16 24 40 / .05);
--track:#eef0f5;--bar-active:#eab308;--bar-done:#16a34a;--bar-failed:#dc2626;--bar-stopped:#9ca3af}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--surface:#171b23;--border:#2a303c;--text:#e7eaf0;--muted:#a0a9b8;
--accent:#a5b4fc;--accent-hover:#c7d2fe;--on-accent:#14172b;--field:#10131a;--ok:#86efac;--err:#fca5a5;
--running-bg:#272c5c;--running:#c7d2fe;--success-bg:#12351f;--success:#86efac;--failed-bg:#451a1a;--failed:#fca5a5;
--interrupted-bg:#42300d;--interrupted:#fcd34d;--shadow:none;
--track:#232935;--bar-active:#facc15;--bar-done:#4ade80;--bar-failed:#f87171;--bar-stopped:#6b7280}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);word-break:keep-all;
font:16px/1.5 system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Noto Sans CJK KR",sans-serif}
main{max-width:960px;margin:0 auto;padding:2.5rem 1.25rem 4rem}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{margin:0;font-size:1.6rem;line-height:1.3;letter-spacing:-.02em;overflow-wrap:anywhere}
h2{margin:0 0 .85rem;font-size:1.05rem}
.brand{display:flex;align-items:center;gap:.9rem;margin-bottom:1.75rem}
.brand p{margin:.1rem 0 0;color:var(--muted);font-size:.95rem}
.brand .nav{flex:none;margin-left:auto;font-size:.925rem;font-weight:600;white-space:nowrap}
.mark{flex:none;display:grid;place-items:center;width:2.75rem;height:2.75rem;border-radius:.8rem;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:1.3rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:.9rem;box-shadow:var(--shadow);padding:1.25rem;margin-bottom:1.25rem}
#f{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) auto;gap:1rem;align-items:end}
label{display:block;font-size:.875rem;font-weight:600}
input,select{display:block;width:100%;height:2.75rem;margin-top:.4rem;padding:0 .8rem;font:inherit;font-weight:400;color:inherit;background:var(--field);border:1px solid var(--border);border-radius:.6rem}
summary{cursor:pointer;border-radius:.3rem}summary h2{display:inline;margin:0}details[open]>summary{margin-bottom:.85rem}
input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{height:2.75rem;padding:0 1.5rem;font:inherit;font-weight:600;color:var(--on-accent);background:var(--accent);border:0;border-radius:.6rem;cursor:pointer;transition:background .15s}
button:hover{background:var(--accent-hover)}
#status{margin:.9rem 0 0;font-size:.925rem;font-weight:600}#status:empty{display:none}
#status.ok,.note.ok{color:var(--ok)}#status.err,.note.err{color:var(--err)}
.projects{table-layout:fixed}.projects th:first-child{width:30%}.projects input,.projects select{margin-top:0}.project-actions{display:flex;align-items:center;gap:.9rem;margin-top:.75rem}
.note{margin:0;font-size:.925rem;font-weight:600}
#group-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem;align-items:end}
#groups-note{margin-top:.75rem}#groups-note:empty{display:none}
#group-list{list-style:none;margin:.9rem 0 0;padding:0}
#group-list:empty::before{content:"그룹이 없습니다.";color:var(--muted);font-size:.925rem}
#group-list li{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.5rem;border-bottom:1px solid var(--border);overflow-wrap:anywhere}
#group-list li:last-child{border-bottom:0}
#group-list button{flex:none;width:auto;height:2.25rem;padding:0 .9rem;font-size:.875rem}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.7rem .5rem;border-bottom:1px solid var(--border);overflow-wrap:anywhere}
tr:last-child>td,tr:last-child>th{border-bottom:0}
th{color:var(--muted);font-size:.8rem;font-weight:600}
.runs td:nth-child(n+3){white-space:nowrap}.runs td:last-child{color:var(--muted);font-size:.9rem}
.runs tbody tr:hover{background:color-mix(in srgb,var(--accent) 6%,transparent)}
.meta th{width:6.5rem;vertical-align:top;padding-top:.85rem}
#runs-note{margin:.75rem .5rem 0;color:var(--muted);font-size:.925rem}#runs-note:empty{display:none}
#search{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1.5fr) minmax(0,1fr) auto auto;gap:.75rem;align-items:end;margin-bottom:.75rem}
button.secondary{color:var(--text);background:transparent;border:1px solid var(--border)}
button.secondary:hover:not(:disabled){background:var(--border)}
button:disabled{opacity:.45;cursor:default}
#pager{display:flex;align-items:center;justify-content:center;gap:.9rem;margin-top:.9rem;color:var(--muted);font-size:.925rem}
#pager[hidden]{display:none}#pager button{width:auto}
.back{display:inline-block;margin-bottom:1rem;font-size:.925rem}
.title{margin-bottom:1.5rem}.title .badge{margin-top:.6rem}
.badge{display:inline-flex;align-items:center;gap:.4rem;padding:.15rem .65rem;border-radius:1rem;font-size:.8rem;font-weight:600;white-space:nowrap;background:var(--border);color:var(--text)}
.badge::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:currentColor}
.running{background:var(--running-bg);color:var(--running)}.running::before{animation:pulse 1.4s ease-in-out infinite}
.success{background:var(--success-bg);color:var(--success)}
.failed{background:var(--failed-bg);color:var(--failed)}
.interrupted{background:var(--interrupted-bg);color:var(--interrupted)}
@keyframes pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.running::before{animation:none}button{transition:none}}
pre{margin:0;background:#11141b;color:#d7dce5;border:1px solid #262b36;border-radius:.6rem;padding:1rem;min-height:12rem;max-height:60vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;
font:.85rem/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans Mono CJK KR",monospace}
pre:empty::before{content:"표시할 로그가 없습니다.";color:#8a93a3}
.views{display:inline-flex;gap:.25rem;padding:.25rem;margin-bottom:1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:.7rem}
.views a{padding:.35rem .95rem;border-radius:.5rem;font-size:.9rem;font-weight:600;color:var(--muted)}
.views a:hover{text-decoration:none;color:var(--text)}.views a[aria-current]{background:var(--accent);color:var(--on-accent)}
.legend{display:flex;flex-wrap:wrap;gap:.5rem 1rem;margin:0 0 .75rem;color:var(--muted);font-size:.85rem}
.legend span{display:inline-flex;align-items:center;gap:.4rem}.legend .bar{position:static;display:inline-block;width:.9rem;height:.6rem}
.timeline{list-style:none;margin:0;padding:0;max-height:70vh;overflow:auto}
.timeline li{display:grid;grid-template-columns:minmax(0,13rem) minmax(0,1fr) 5.5rem;gap:.75rem;align-items:center;padding:.3rem 0;font-size:.875rem}
.timeline .total{font-weight:700;border-bottom:1px solid var(--border);padding-bottom:.6rem;margin-bottom:.3rem}
.timeline .name{overflow-wrap:anywhere}
.track{position:relative;height:.8rem;background:var(--track);border-radius:.4rem}
.bar{position:absolute;top:0;bottom:0;min-width:3px;border-radius:.4rem}
.bar.active{background:var(--bar-active)}.bar.done{background:var(--bar-done)}.bar.failed{background:var(--bar-failed)}.bar.stopped{background:var(--bar-stopped)}
.dur{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{margin:.75rem 0 0;color:var(--muted);font-size:.925rem}
#timeline:empty{display:none}#timeline .timeline{max-height:40vh}#timeline h2 a{font-weight:400}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (max-width:640px){main{padding:1.5rem 1rem 3rem}#f,#search,#group-form{grid-template-columns:minmax(0,1fr)}button{width:100%}
.runs thead{display:none}.runs tr{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:.4rem .6rem;padding:.75rem .25rem;border-bottom:1px solid var(--border)}
.runs tbody tr:last-child{border-bottom:0}.runs td{padding:0;border:0}.runs td:first-child,.runs td:nth-child(2){grid-column:1/-1}.runs td:nth-child(2){color:var(--muted);font-size:.9rem}
.brand{flex-wrap:wrap}.brand>div{flex:1 1 calc(100% - 3.65rem)}.brand .nav{margin-left:3.65rem}
.projects thead{display:none}.projects tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.4rem .6rem;padding:.75rem .25rem;border-bottom:1px solid var(--border)}
.projects tr:last-child{border-bottom:0}.projects td{padding:0;border:0}.projects td:first-child{grid-column:1/-1;font-weight:600}
.timeline li{grid-template-columns:minmax(0,1fr) auto;gap:.3rem .75rem}.timeline .track{grid-column:1/-1;grid-row:2}}
</style>`;

const page = (projects) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>노션 개발 러너</title>
${style}
<main>
<header class="brand"><span class="mark" aria-hidden="true">N</span><div><h1>노션 개발 러너</h1><p>노션 문서의 지시대로 새 브랜치에서 개발하고 결과를 문서에 정리합니다.</p></div><a class="nav" href="/projects">프로젝트 관리</a></header>
<section class="card">
<form id="f"><label>프로젝트<select name="project" required>${projectOptions(projects)}</select></label>
<label>노션 링크<input name="url" type="url" placeholder="https://www.notion.so/..." required></label><button>시작</button></form>
<p id="status" role="status"></p>
</section>
<div id="timeline"></div>
<details class="card" id="log-card" open><summary><h2>실시간 로그</h2></summary><pre id="log" aria-live="polite"></pre></details>
<section class="card"><h2>작업 기록</h2>
<form id="search" role="search"><label>제목<input name="q" type="search" placeholder="제목으로 검색"></label>
<label>프로젝트<select name="project">${projectOptions(projects, '전체')}</select></label>
<label>날짜<input name="date" type="date"></label>
<button>검색</button><button type="reset" class="secondary">초기화</button></form>
<table class="runs"><thead><tr><th>제목</th><th>프로젝트</th><th>상태</th><th>시작</th></tr></thead><tbody id="runs"></tbody></table>
<p id="runs-note" role="status"></p>
<nav id="pager" aria-label="작업 기록 페이지" hidden><button id="prev" type="button" class="secondary">이전</button><span id="page-info"></span><button id="next" type="button" class="secondary">다음</button></nav></section>
</main>
<script>
const log = document.getElementById('log');
// A collapsed log cannot scroll, so catch up on the lines that arrived meanwhile.
document.getElementById('log-card').addEventListener('toggle', (e) => { if (e.target.open) log.scrollTop = log.scrollHeight; });
const runsEl = document.getElementById('runs');
const runsNote = document.getElementById('runs-note');
const searchForm = document.getElementById('search');
const pager = document.getElementById('pager');
const prev = document.getElementById('prev');
const next = document.getElementById('next');
const pageInfo = document.getElementById('page-info');
let currentPage = 1;
let filter = new URLSearchParams();
let latestLoad = 0;
// The server stores UTC but the list shows local time, so a picked date means that local day.
function readFilter() {
  const data = new FormData(searchForm);
  const params = new URLSearchParams();
  const q = data.get('q').trim();
  if (q) params.set('q', q);
  if (data.get('project')) params.set('project', data.get('project'));
  if (data.get('date')) {
    const day = new Date(data.get('date') + 'T00:00:00');
    params.set('from', day.toISOString());
    day.setDate(day.getDate() + 1);
    params.set('to', day.toISOString());
  }
  return params;
}
async function loadRuns() {
  const load = ++latestLoad;
  try {
    const params = new URLSearchParams(filter);
    params.set('page', currentPage);
    const res = await fetch('/runs?' + params);
    if (!res.ok) throw new Error();
    const { runs, total, page, pageSize } = await res.json();
    // A slower, older response must not overwrite the result of a newer search.
    if (load !== latestLoad) return;
    currentPage = page;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    pager.hidden = total <= pageSize;
    pageInfo.textContent = page + ' / ' + lastPage + ' 페이지 (총 ' + total + '건)';
    prev.disabled = page <= 1;
    next.disabled = page >= lastPage;
    runsNote.textContent = runs.length ? '' : (filter.size ? '검색 결과가 없습니다.' : '작업 기록이 없습니다.');
    runsEl.replaceChildren(...runs.map((r) => {
      const link = document.createElement('a');
      link.href = '/runs/' + r.id;
      link.textContent = r.title;
      const badge = document.createElement('span');
      badge.className = 'badge ' + r.status;
      badge.textContent = r.statusLabel;
      const row = document.createElement('tr');
      for (const content of [link, r.alias || r.project, badge, new Date(r.started_at).toLocaleString()]) {
        row.insertCell().append(content);
      }
      return row;
    }));
  } catch {
    if (load === latestLoad) runsNote.textContent = '작업 기록을 불러오지 못했습니다.';
  }
}
searchForm.onsubmit = (e) => {
  e.preventDefault();
  filter = readFilter();
  currentPage = 1;
  loadRuns();
};
// The reset event fires before the fields clear, so the filter is simply emptied here.
searchForm.onreset = () => {
  filter = new URLSearchParams();
  currentPage = 1;
  loadRuns();
};
prev.onclick = () => { currentPage -= 1; loadRuns(); };
next.onclick = () => { currentPage += 1; loadRuns(); };
const timelineEl = document.getElementById('timeline');
let timelineTimer;
const scheduleTimeline = (ms) => { clearTimeout(timelineTimer); timelineTimer = setTimeout(loadTimeline, ms); };
// Bars keep growing between log lines, so a live run is polled; the list's scroll position survives each refresh.
async function loadTimeline() {
  try {
    const res = await fetch('/timeline');
    if (res.ok) {
      const old = timelineEl.querySelector('.timeline');
      const atEnd = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 4;
      const top = old ? old.scrollTop : 0;
      timelineEl.innerHTML = await res.text();
      const list = timelineEl.querySelector('.timeline');
      if (list) list.scrollTop = atEnd ? list.scrollHeight : top;
    }
  } catch { /* the next log line or poll tries again */ }
  if (timelineEl.querySelector('.bar.active')) scheduleTimeline(2000);
}
const es = new EventSource('/events');
es.onopen = () => { log.textContent = ''; loadRuns(); loadTimeline(); };
es.addEventListener('runs', () => { loadRuns(); scheduleTimeline(100); });
const status = document.getElementById('status');
es.onmessage = (e) => {
  scheduleTimeline(300);
  const text = JSON.parse(e.data);
  if (text.startsWith('시작: ')) log.textContent = '';
  log.textContent += text + '\\n';
  log.scrollTop = log.scrollHeight;
};
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const body = JSON.stringify(Object.fromEntries(new FormData(e.target)));
  status.className = '';
  status.textContent = '요청 중...';
  try {
    const res = await fetch('/run', { method: 'POST', body });
    status.className = res.ok ? 'ok' : 'err';
    status.textContent = (res.ok ? '' : '거부됨: ') + (await res.text());
  } catch {
    status.className = 'err';
    status.textContent = '서버에 연결하지 못했습니다.';
  }
};
</script></html>`;

const projectsPage = ({ rows, groups }) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>프로젝트 관리 - 노션 개발 러너</title>
${style}
<main>
<a class="back" href="/">← 목록</a>
<header class="title"><h1>프로젝트 관리</h1></header>
<section class="card"><h2>그룹</h2>
<form id="group-form"><label>새 그룹<input name="name" maxlength="50" required></label><button>추가</button></form>
<p id="groups-note" class="note" role="status"></p>
<ul id="group-list">${groupItems(groups)}</ul></section>
<section class="card"><h2>프로젝트</h2>
<form id="projects"><table class="projects"><thead><tr><th>폴더</th><th>별칭</th><th>그룹</th></tr></thead><tbody>
${rows.map((r) => `<tr data-name="${escapeHtml(r.name)}"><td>${escapeHtml(r.name)}</td>
<td><input name="alias" maxlength="50" placeholder="별칭" aria-label="${escapeHtml(r.name)} 별칭" value="${escapeHtml(r.alias)}"></td>
<td><select name="group" aria-label="${escapeHtml(r.name)} 그룹">${groupOptions(groups, r.group)}</select></td></tr>`).join('')}
</tbody></table>
<div class="project-actions"><button>저장</button><p id="projects-note" class="note" role="status"></p></div></form></section>
</main>
<script>
const groupForm = document.getElementById('group-form');
const groupList = document.getElementById('group-list');
const groupsNote = document.getElementById('groups-note');
const projectForm = document.getElementById('projects');
const projectNote = document.getElementById('projects-note');
function note(el, kind, text) {
  el.className = 'note ' + kind;
  el.textContent = text;
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res;
}
// Choices not saved yet stay selected, except the ones pointing at a group that no longer exists.
function showGroups({ groups, options, items }) {
  groupList.innerHTML = items;
  for (const select of projectForm.querySelectorAll('select[name=group]')) {
    const selected = select.value;
    select.innerHTML = options;
    select.value = groups.includes(selected) ? selected : '';
  }
}
groupForm.onsubmit = async (e) => {
  e.preventDefault();
  const name = groupForm.elements.name.value;
  try {
    showGroups(await (await post('/groups', { name })).json());
    groupForm.reset();
    note(groupsNote, 'ok', '추가했습니다.');
  } catch (err) {
    note(groupsNote, 'err', '추가하지 못했습니다. ' + err.message);
  }
};
groupList.onclick = async (e) => {
  const item = e.target.closest('button') && e.target.closest('li');
  if (!item) return;
  const name = item.dataset.group;
  if (!confirm('"' + name + '" 그룹을 삭제할까요? 이 그룹의 프로젝트는 미분류로 옮겨집니다.')) return;
  try {
    showGroups(await (await post('/groups/delete', { name })).json());
    note(groupsNote, 'ok', '삭제했습니다.');
  } catch (err) {
    note(groupsNote, 'err', '삭제하지 못했습니다. ' + err.message);
  }
};
projectForm.onsubmit = async (e) => {
  e.preventDefault();
  const body = [...projectForm.querySelectorAll('tr[data-name]')].map((row) => ({
    name: row.dataset.name,
    alias: row.querySelector('[name=alias]').value,
    group: row.querySelector('[name=group]').value,
  }));
  note(projectNote, '', '저장 중...');
  try {
    await post('/projects', body);
    note(projectNote, 'ok', '저장했습니다.');
  } catch (err) {
    note(projectNote, 'err', '저장하지 못했습니다. ' + err.message);
  }
};
</script></html>`;

const BAR_LABELS = { active: '진행 중', done: '완료', failed: '실패', stopped: '중단됨' };
const barRow = (bar, attrs = '') => `<li${attrs}><span class="name">${escapeHtml(bar.name)}</span><span class="track"><span class="bar ${bar.state}" style="left:${bar.left}%;width:${bar.width}%"></span></span><span class="dur">${escapeHtml(bar.duration)}<span class="sr"> ${BAR_LABELS[bar.state]}</span></span></li>`;

// heading lets the home page name and link the run it is showing.
const timelineSection = (run, timeline, heading = '작업 시간') => `<section class="card"><h2>${heading}</h2>
${run.status === 'queued' ? '<p class="muted">아직 시작하지 않았습니다.</p>' : `<p class="legend" aria-hidden="true">${Object.entries(BAR_LABELS).map(([state, label]) => `<span><i class="bar ${state}"></i>${label}</span>`).join('')}</p>
<ol class="timeline">${barRow(timeline.total, ' class="total"')}${timeline.steps.map((bar) => barRow(bar)).join('')}</ol>
${timeline.steps.length ? '' : '<p class="muted">도구 기록이 없습니다. 이 기능을 넣기 전의 작업이거나 도구를 쓰지 않은 작업입니다.</p>'}`}
</section>`;

// timeline is null in the simple view.
const detailPage = (run, logs, alias, timeline) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(run.title)}</title>
${['queued', 'running'].includes(run.status) ? '<meta http-equiv="refresh" content="3">' : ''}
${style}
<main>
<a class="back" href="/">← 목록</a>
<header class="title"><h1>${escapeHtml(run.title)}</h1><span class="badge ${escapeHtml(run.status)}">${escapeHtml(run.statusLabel)}</span></header>
<nav class="views" aria-label="보기 방식">${timeline
    ? `<a href="/runs/${run.id}">간단히</a><a href="?view=time" aria-current="page">자세히</a>`
    : `<a href="/runs/${run.id}" aria-current="page">간단히</a><a href="?view=time">자세히</a>`}</nav>
${timeline ? timelineSection(run, timeline) : ''}
<section class="card"><table class="meta">
<tr><th>프로젝트</th><td>${escapeHtml(alias ? `${alias} (${run.project})` : run.project)}</td></tr>
<tr><th>브랜치</th><td>${escapeHtml(run.branch || '-')}</td></tr>
<tr><th>노션 문서</th><td><a href="${escapeHtml(run.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(run.url)}</a></td></tr>
<tr><th>시작</th><td><time datetime="${escapeHtml(run.started_at)}">${escapeHtml(run.started_at)}</time></td></tr>
<tr><th>종료</th><td>${run.finished_at ? `<time datetime="${escapeHtml(run.finished_at)}">${escapeHtml(run.finished_at)}</time>` : '-'}</td></tr>
</table></section>
<section class="card"><h2>작업 내용</h2><pre>${escapeHtml(logs.join('\n'))}</pre></section>
</main>
<script>
for (const t of document.querySelectorAll('time')) t.textContent = new Date(t.dateTime).toLocaleString();
</script></html>`;

function runClaude(prompt, cwd) {
  return spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--mcp-config', path.join(__dirname, 'mcp.json'), '--strict-mcp-config'],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function createApp({ root, start = runClaude, db = openDb(':memory:') }) {
  let current = null;
  // The home page keeps showing the last run's bars after it ends.
  let lastRunId = null;
  const queue = [];
  let log = [];
  const clients = new Set();
  const emit = (text) => {
    log.push(text);
    for (const c of clients) c.write(`data: ${JSON.stringify(text)}\n\n`);
  };
  const notifyRuns = () => {
    for (const c of clients) c.write('event: runs\ndata: {}\n\n');
  };
  // These run from stream callbacks, where a throw would take the whole server down mid-run.
  const record = (write) => {
    try { write(); } catch (err) { console.error(`작업 기록 저장 실패: ${err.message}`); }
  };

  const isRepo = (project) => fs.existsSync(path.join(root, project, '.git'));

  // Done when a run starts, not when it is queued: an earlier run may still be changing the same tree.
  function createBranch(project) {
    const cwd = path.join(root, project);
    if (!isRepo(project)) throw new Error('git 저장소가 아닙니다.');
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (git('status', '--porcelain').trim()) throw new Error('커밋하지 않은 변경이 있습니다.');
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const base = `notion/${stamp}`;
    // A queued run can start within the same second when the one before it fails fast.
    let branch = base;
    for (let n = 2; git('branch', '--list', branch).trim(); n += 1) branch = `${base}-${n}`;
    git('switch', '-c', branch);
    return branch;
  }

  // A run that can't start is recorded as failed and the queue moves on, so one bad job doesn't block the rest.
  function startNext() {
    const job = queue.shift();
    if (!job) return;
    let branch;
    try {
      branch = createBranch(job.project);
      db.startRun(job.runId, branch);
    } catch (err) {
      const message = `실패: ${err.message}`;
      emit(`${job.project} ${message}`);
      record(() => db.appendLog(job.runId, message));
      record(() => db.finishRun(job.runId, 'failed'));
      notifyRuns();
      startNext();
      return;
    }
    try {
      launch(job.runId, job.project, job.url, branch);
    } catch { /* launch already recorded the failure and moved on */ }
  }

  function launch(runId, project, url, branch) {
    const cwd = path.join(root, project);
    const say = (text) => {
      record(() => db.appendLog(runId, text));
      emit(text);
    };
    current = { project, url };
    lastRunId = runId;
    log = [];
    say(`시작: ${project} (${branch})`);
    notifyRuns();

    let result = null;
    let finished = false;
    const finish = (status, message) => {
      if (finished) return;
      finished = true;
      current = null;
      say(message);
      record(() => db.finishRun(runId, status));
      notifyRuns();
      startNext();
    };
    let child;
    try {
      const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8')
        .replaceAll('{{URL}}', () => url).replaceAll('{{BRANCH}}', () => branch);
      child = start(prompt, cwd);
    } catch (err) {
      finish('failed', `실패: ${err.message}`);
      throw err;
    }
    let buffered = '';
    const steps = new Map();
    // One bar per tool call: from the call until its result comes back.
    const trackSteps = (e) => {
      for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (e.type === 'assistant' && c.type === 'tool_use' && typeof c.name === 'string') {
          record(() => steps.set(c.id, db.startStep(runId, c.name)));
        } else if (e.type === 'user' && c.type === 'tool_result' && steps.has(c.tool_use_id)) {
          record(() => db.finishStep(steps.get(c.tool_use_id)));
        }
      }
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      const lines = (buffered + chunk).split('\n');
      buffered = lines.pop();
      for (const line of lines.filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          trackSteps(e);
          if (e.type === 'result') {
            result = e;
            const summary = extractSummary(e.result);
            if (summary) record(() => db.setSummary(runId, summary));
          }
        } catch { /* plain text is shown as is */ }
        const text = formatEvent(line);
        if (text) say(text);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (t) => say(t.trimEnd()));
    child.on('error', (err) => finish('failed', `실패: ${err.message}`));
    child.on('close', (code) => {
      if (code === 0 && result && !result.is_error) finish('success', '완료: 브랜치와 노션 문서를 확인하세요.');
      else finish('failed', `실패: 종료 코드 ${code}`);
    });
  }

  return http.createServer((req, res) => {
    const port = req.socket.localPort;
    const projects = () => projectView(listProjects(root), db.listProjectSettings(), db.listGroups());
    const send = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
    };
    const isPost = req.method === 'POST';
    if (!isLocalRequest(req.headers, port, isPost)) return send(403, '로컬 요청만 허용합니다.');

    if (req.method === 'GET' && req.url === '/') {
      // no-store: returning from the management page must show the saved project names.
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page(projects()));
    }
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      // Without this the browser sees no open event until the first log line, and the run list stays empty.
      res.flushHeaders();
      for (const text of log) res.write(`data: ${JSON.stringify(text)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    const [pathname, query] = req.url.split('?', 2);
    if (req.method === 'GET' && req.url === '/timeline') {
      const run = lastRunId && db.getRun(lastRunId);
      const heading = run && `작업 시간 · <a href="/runs/${run.id}?view=time">${escapeHtml(run.title)}</a>`;
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(run ? timelineSection(runView(run), timelineView(run, db.getSteps(run.id)), heading) : '');
    }
    if (req.method === 'GET' && pathname === '/projects') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(projectsPage(projects()));
    }
    if (req.method === 'GET' && pathname === '/runs') {
      const filter = parseRunFilter(new URLSearchParams(query));
      if (!filter) return send(400, '잘못된 날짜입니다.');
      const list = db.listRuns(filter);
      return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ ...list, runs: list.runs.map(runView) }));
    }
    const detail = req.method === 'GET' && pathname.match(/^\/runs\/(\d{1,15})$/);
    if (detail) {
      const run = db.getRun(Number(detail[1]));
      if (!run) return send(404, '없는 작업입니다.');
      const timeline = new URLSearchParams(query).get('view') === 'time' ? timelineView(run, db.getSteps(run.id)) : null;
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(detailPage(runView(run), db.getLogs(run.id), db.getProjectSettings(run.project)?.alias, timeline));
    }
    if (!isPost || !['/run', '/projects', '/groups', '/groups/delete'].includes(req.url)) return send(404, '없는 경로입니다.');

    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8').on('data', (chunk) => {
      body += chunk;
      if (body.length > 100000) { tooLarge = true; body = ''; }
    });
    req.on('end', () => {
      if (tooLarge) return send(413, '요청이 너무 큽니다.');
      let input;
      try { input = JSON.parse(body); } catch { return send(400, '잘못된 요청입니다.'); }
      const sendGroups = () => {
        const { groups } = projects();
        return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ groups, options: groupOptions(groups), items: groupItems(groups) }));
      };
      try {
        if (req.url === '/projects') {
          const settings = parseProjectSettings(input, listProjects(root), db.listGroups());
          if (!settings) return send(400, '별칭과 그룹을 확인해 주세요.');
          db.saveProjectSettings(settings);
          return send(200, '저장했습니다.');
        }
        if (req.url === '/groups') {
          const name = parseGroupName(input?.name);
          if (!name) return send(400, `그룹 이름을 확인해 주세요. 50자 이내이고 ${UNGROUPED}은 쓸 수 없습니다.`);
          if (!db.addGroup(name)) return send(409, '이미 있는 그룹입니다.');
          return sendGroups();
        }
        if (req.url === '/groups/delete') {
          if (typeof input?.name !== 'string' || !db.deleteGroup(input.name)) return send(404, '없는 그룹입니다.');
          return sendGroups();
        }
      } catch (err) {
        return send(500, err.message);
      }
      if (!isValidProject(input?.project, root)) return send(400, '없는 프로젝트입니다.');
      const url = parseNotionUrl(input.url);
      if (!url) return send(400, '노션 링크가 아닙니다.');
      if (start === runClaude && !process.env.NOTION_TOKEN) return send(400, 'NOTION_TOKEN이 설정되지 않았습니다.');
      // Also what stops a double click from running the same document twice.
      const same = (job) => job.project === input.project && job.url === url;
      if ((current && same(current)) || queue.some(same)) return send(409, '같은 문서의 작업이 이미 실행 중이거나 대기 중입니다.');
      try {
        if (current) {
          if (!isRepo(input.project)) return send(400, 'git 저장소가 아닙니다.');
          const runId = db.enqueueRun({ project: input.project, url });
          queue.push({ runId, project: input.project, url });
          notifyRuns();
          return send(202, `대기 중입니다. 앞선 작업이 끝나면 순서대로 시작합니다. (대기 ${queue.length}번째)`);
        }
        const branch = createBranch(input.project);
        launch(db.createRun({ project: input.project, url, branch }), input.project, url, branch);
        return send(202, '시작했습니다.');
      } catch (err) {
        return send(400, err.message);
      }
    });
    return undefined;
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4317;
  const root = process.env.RUNNER_ROOT || path.resolve(__dirname, '..');
  // Docker must listen on all container interfaces; compose publishes it to 127.0.0.1 only.
  const db = openDb(process.env.RUNNER_DB || path.join(__dirname, 'runner.db'));
  createApp({ root, db }).listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${port}`);
  });
}

module.exports = { createApp };
