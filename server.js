const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const {
  AGENTS, codexTranslator, listProjects, parseProjectSettings, parseGroupName, projectView, projectOptions, groupOptions, groupItems, escapeHtml, isValidProject, parseRunRequest, buildPrompt, MAX_TASK_LENGTH, isLocalRequest, formatEvent, runView, extractSummary, parseRunFilter, UNGROUPED, timelineView, groupLog, maskSecrets,
} = require('./lib');
const { openDb } = require('./db');

// Dark palette, applied by the OS setting unless the user picked a theme with the GNB toggle.
const darkVars = `--bg:#0e1420;--surface:#162033;--border:#25324a;--field-border:#2c3a55;--text:#e3e9f5;--muted:#9aa7bf;
--accent:#8fb0ff;--accent-hover:#b3c9ff;--accent-soft:#1e2c4d;--on-accent:#0f1a33;--field:#111a2b;--ok:#7fd8a8;--err:#fca5a5;
--running-bg:#3b3115;--running:#f2d27a;--success-bg:#143524;--success:#7fd8a8;--failed-bg:#451c1c;--failed:#fca5a5;
--interrupted-bg:#232d40;--interrupted:#b6c0d3;--shadow:none;
--log-bg:#111a2b;--log-text:#c3cde0;--log-empty:#7d8aa3;
--track:#22304a;--bar-active:#f2c94c;--bar-done:#5cc794;--bar-failed:#f87171;--bar-stopped:#6b7790`;

// Inline the shared vector so every page and Docker image use the same logo.
const logoSvg = fs.readFileSync(path.join(__dirname, 'assets/logo.svg'), 'utf8').trim();
const favicon = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(logoSvg.replace('<svg ', '<svg color="#345fc7" '))}">`;

const style = `<style>
:root{color-scheme:light dark;--bg:#f3f6fb;--surface:#fff;--border:#e0e7f0;--field-border:#dce3ef;--text:#263550;--muted:#66748c;
--accent:#345fc7;--accent-hover:#2a4fa8;--accent-soft:#e5edff;--on-accent:#fff;--field:#fbfcff;--ok:#1f7a4f;--err:#b42318;
--running-bg:#fff3cb;--running:#7a5a10;--success-bg:#dff4e8;--success:#1f6e47;--failed-bg:#fde4e2;--failed:#9b2a20;
--interrupted-bg:#eef1f6;--interrupted:#5a667c;--shadow:0 5px 20px rgb(37 76 128 / .05);
--log-bg:#fbfcff;--log-text:#4b5b78;--log-empty:#8a97ad;
--track:#edf1f8;--bar-active:#edbd38;--bar-done:#43a876;--bar-failed:#d9534f;--bar-stopped:#a3adbf}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;${darkVars}}}
:root[data-theme=dark]{color-scheme:dark;${darkVars}}:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}
html{font-size:14px;scrollbar-gutter:stable}
body{margin:0;background:var(--bg);color:var(--text);word-break:keep-all;
font:1rem/1.5 system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Noto Sans CJK KR",sans-serif}
main{max-width:1240px;margin:0 auto;padding:2.25rem 1.5rem 4rem}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{margin:0;font-size:2rem;line-height:1.25;letter-spacing:-.04em;overflow-wrap:anywhere}
h2{margin:0 0 1.25rem;font-size:1.05rem;letter-spacing:-.02em}
.gnb{position:sticky;top:0;z-index:10;background:var(--surface);border-bottom:1px solid var(--border);box-shadow:var(--shadow)}
.gnb-inner{display:flex;align-items:center;gap:3rem;max-width:1240px;height:4.5rem;margin:0 auto;padding:0 1.5rem}
.gnb-brand{display:flex;align-items:center;gap:.6rem;flex:none;color:var(--text);font-weight:700;white-space:nowrap}
.gnb-brand{font-size:1.1rem}.gnb-brand:hover{text-decoration:none}
.gnb-brand .mark{display:block;width:2.5rem;height:2.5rem;border-radius:0;background:transparent;color:var(--accent)}
.gnb-brand .mark svg{display:block;width:100%;height:100%}
.gnb-brand:focus-visible{outline:2px solid var(--accent);outline-offset:5px;border-radius:4px}
.gnb nav{display:flex;align-items:stretch;align-self:stretch;gap:1.25rem}
.gnb nav a{display:flex;align-items:center;padding:0 .25rem;border-bottom:3px solid transparent;color:var(--muted);font-size:.925rem;font-weight:600;white-space:nowrap}
.gnb nav a:hover{text-decoration:none;color:var(--text)}
.gnb nav a[aria-current]{color:var(--accent);border-bottom-color:var(--accent)}
.gnb .theme-toggle{flex:none;width:2.4rem;height:2.4rem;margin-left:auto;padding:0;display:grid;place-items:center;color:var(--text);background:transparent;border:1px solid var(--border);border-radius:8px;font-size:1.1rem;line-height:1}
.gnb .theme-toggle:hover{background:var(--accent-soft)}
.brand,.title{margin-bottom:1.75rem}
.brand p,.title p{margin:.5rem 0 0;color:var(--muted);font-size:.9rem;line-height:1.7}
.mark{flex:none;display:grid;place-items:center;width:2.75rem;height:2.75rem;border-radius:.8rem;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:1.3rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);padding:1.75rem;margin-bottom:1.5rem}
.workspace{display:grid;grid-template-columns:minmax(0,28rem) minmax(0,1fr);gap:1.5rem;align-items:start}
.workspace>*{grid-column:2;margin-bottom:0}.workspace>.request{grid-column:1;grid-row:1/span 2}
#f{display:grid;gap:1.25rem}
.submit{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-top:.5rem}.submit span{color:var(--muted);font-size:.8rem}
textarea{display:block;width:100%;min-height:9rem;margin-top:.55rem;padding:.75rem .9rem;font:inherit;font-weight:400;line-height:1.8;color:inherit;background:var(--field);border:1px solid var(--field-border);border-radius:6px;resize:vertical}
.hint{display:block;margin-top:.6rem;color:var(--muted);font-size:.8rem;font-weight:400;line-height:1.7}
.task-text{white-space:pre-wrap;overflow-wrap:anywhere}
label{display:block;font-size:.875rem;font-weight:600}
input,select{display:block;width:100%;height:2.9rem;margin-top:.55rem;padding:0 .9rem;font:inherit;font-weight:400;color:inherit;background:var(--field);border:1px solid var(--field-border);border-radius:6px}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
summary{cursor:pointer;border-radius:.3rem}summary h2{display:inline;margin:0}details[open]>summary{margin-bottom:.85rem}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{height:2.9rem;padding:0 1.75rem;font:inherit;font-weight:700;color:var(--on-accent);background:var(--accent);border:0;border-radius:6px;cursor:pointer;transition:background .15s}
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
.runs tbody tr:hover{background:var(--accent-soft)}
.meta th{width:6.5rem;vertical-align:top;padding-top:.85rem}
#runs-note{margin:.75rem .5rem 0;color:var(--muted);font-size:.925rem}#runs-note:empty{display:none}
#search{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1.5fr) minmax(0,1fr) auto auto;gap:.75rem;align-items:end;margin-bottom:.75rem}
button.secondary{color:var(--text);background:transparent;border:1px solid var(--border)}
button.secondary:hover:not(:disabled){background:var(--border)}
button:disabled{opacity:.45;cursor:default}
#list-size{display:flex;align-items:center;justify-content:flex-end;gap:.75rem;margin-bottom:.75rem}
#list-size select{width:auto;margin:0}
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
pre{margin:0;background:var(--log-bg);color:var(--log-text);border:1px solid var(--border);border-radius:10px;padding:1rem 1.1rem;min-height:12rem;max-height:60vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;
font:.8rem/2 ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans Mono CJK KR",monospace}
pre:empty::before{content:"표시할 로그가 없습니다.";color:var(--log-empty)}
.views{display:inline-flex;gap:.25rem;padding:.25rem;margin-bottom:1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:.7rem}
.views a{padding:.35rem .95rem;border-radius:6px;font-size:.9rem;font-weight:600;color:var(--muted)}
.views a:hover{text-decoration:none;color:var(--text)}.views a[aria-current]{background:var(--accent);color:var(--on-accent)}
.legend{display:flex;flex-wrap:wrap;gap:.5rem 1rem;margin:0 0 .75rem;color:var(--muted);font-size:.85rem}
.legend span{display:inline-flex;align-items:center;gap:.4rem}.legend .bar{position:static;display:inline-block;width:.5rem;height:.5rem;border-radius:50%}
.timeline{list-style:none;margin:0;padding:0;max-height:70vh;overflow:auto}
.timeline li{display:grid;grid-template-columns:minmax(0,11rem) minmax(0,1fr) 4.5rem;gap:1rem;align-items:center;padding:.45rem 0;font-size:.8rem}
.timeline .total{font-weight:700;border-bottom:1px solid var(--border);padding-bottom:1rem;margin-bottom:.5rem}.timeline .total .track{height:1.05rem}
.timeline .name{overflow-wrap:anywhere}
.track{position:relative;height:.75rem;background:var(--track);border-radius:3px;overflow:hidden}
.bar{position:absolute;top:0;bottom:0;min-width:3px;border-radius:3px}
.bar.active{background:var(--bar-active)}.bar.done{background:var(--bar-done)}.bar.failed{background:var(--bar-failed)}.bar.stopped{background:var(--bar-stopped)}
.dur{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{margin:.75rem 0 0;color:var(--muted);font-size:.925rem}
#timeline:empty{display:none}#timeline .timeline{max-height:40vh}#timeline h2 a{font-weight:400}
.board-top{display:flex;align-items:flex-end;justify-content:space-between;gap:1.5rem;flex-wrap:wrap}
.board-tools{display:flex;gap:.5rem;margin-bottom:1.75rem}.board-tools input{width:18rem;margin:0}
a.button{display:inline-flex;align-items:center;height:2.9rem;padding:0 1.25rem;border-radius:6px;font-weight:700;white-space:nowrap}
a.button.secondary{color:var(--accent);background:var(--surface);border:1px solid var(--field-border)}a.button:hover{text-decoration:none;background:var(--accent-soft)}
#board-note{margin:0 0 1rem}#board-note:empty{display:none}
.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));gap:1.1rem;align-items:start}
.col{background:var(--accent-soft);border:2px solid transparent;border-radius:14px;padding:.9rem;transition:border-color .15s}
.col.over{border-color:var(--accent);border-style:dashed}
.colhead{display:flex;align-items:center;gap:.5rem;padding:.2rem .35rem .8rem}.colhead h2{margin:0;font-size:.95rem}
.colmark{width:4px;height:1rem;border-radius:2px}.count{font-size:.75rem;color:var(--muted);background:var(--surface);border-radius:1rem;padding:0 .5rem}
button.link{height:auto;padding:0;background:none;color:var(--accent);font-size:.75rem;font-weight:700}button.link:hover{background:none;text-decoration:underline}
.colhead .del{margin-left:auto;color:var(--muted)}
.pcard{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.9rem;margin-bottom:.65rem;box-shadow:var(--shadow);cursor:grab}
.pcard[hidden]{display:none}.pcard.dragging{opacity:.45}.pcard.editing{border:2px solid var(--accent);cursor:default}
.pc-head{display:flex;align-items:center;gap:.5rem}.pc-head .alias{font-size:1rem;overflow-wrap:anywhere}.pc-head .alias.empty{color:var(--muted)}.pc-head .edit{margin-left:auto}
.pcard .folder{margin-top:.1rem;color:var(--muted);font:.8rem ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
.pcard .meta{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.75rem;font-size:.72rem;color:var(--muted)}.pcard .meta span{background:var(--bg);border-radius:4px;padding:.1rem .45rem}
.pcard .meta .s-success{background:var(--success-bg);color:var(--success)}.pcard .meta .s-failed{background:var(--failed-bg);color:var(--failed)}
.pcard .meta .s-running,.pcard .meta .s-queued{background:var(--running-bg);color:var(--running)}
.editor label{margin-top:.75rem;font-size:.75rem;color:var(--muted)}.editor input,.editor select{height:2.4rem;margin-top:.3rem}
.editor .row{display:flex;gap:.4rem;margin-top:.8rem}.editor .row button{height:2.2rem;padding:0 .9rem;font-size:.8rem}
.drop{display:none;margin:0;padding:.85rem;border:2px dashed var(--field-border);border-radius:12px;text-align:center;color:var(--muted);font-size:.75rem}
.cards:empty+.drop,.col.over .drop{display:block}
.newcol{border:2px dashed var(--field-border);border-radius:14px;padding:1.1rem}.newcol label{color:var(--accent)}.newcol button{width:100%;margin-top:.6rem}
@media (max-width:640px){.board-tools{width:100%}.board-tools input{width:auto;flex:1}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (max-width:900px){.workspace{grid-template-columns:minmax(0,1fr)}.workspace>*,.workspace>.request{grid-column:1;grid-row:auto}}
@media (max-width:640px){main{padding:1.5rem 1rem 3rem}.card{padding:1.25rem}h1{font-size:1.6rem}#search,#group-form{grid-template-columns:minmax(0,1fr)}button{width:100%}.submit{flex-direction:column-reverse;align-items:stretch}
.runs thead{display:none}.runs tr{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:.4rem .6rem;padding:.75rem .25rem;border-bottom:1px solid var(--border)}
.runs tbody tr:last-child{border-bottom:0}.runs td{padding:0;border:0}.runs td:first-child,.runs td:nth-child(2){grid-column:1/-1}.runs td:nth-child(2){color:var(--muted);font-size:.9rem}
.gnb-inner{gap:.75rem;height:3.75rem;padding:0 .75rem}.gnb-brand span.name{display:none}.gnb nav{gap:0;margin-left:auto}.gnb nav a{padding:0 .6rem}.gnb .theme-toggle{width:2.4rem;margin-left:0}
.projects thead{display:none}.projects tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.4rem .6rem;padding:.75rem .25rem;border-bottom:1px solid var(--border)}
.projects tr:last-child{border-bottom:0}.projects td{padding:0;border:0}.projects td:first-child{grid-column:1/-1;font-weight:600}
.timeline li{grid-template-columns:minmax(0,1fr) auto;gap:.3rem .75rem}.timeline .track{grid-column:1/-1;grid-row:2}}
</style>
<script>
(() => {
  // Apply the saved theme before the page paints to avoid a flash of the wrong colors.
  try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch {}
})();
</script>`;

// Global navigation shown on every page; `current` marks the active menu.
const gnb = (current) => {
  const item = (key, href, label) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="gnb"><div class="gnb-inner"><a class="gnb-brand" href="/" aria-label="노션 개발 러너 홈"><span class="mark" aria-hidden="true">${logoSvg}</span><span class="name">노션 개발 러너</span></a>
<nav aria-label="주 메뉴">${item('history', '/', '업무 내역')}${item('execute', '/execute', '업무 실행')}${item('projects', '/projects', '프로젝트 관리')}</nav>
<button type="button" class="theme-toggle" id="theme-toggle" aria-label="다크 모드로 변경"></button></div></header>
<script>
(() => {
  // Light/dark toggle: remembers the choice; without one, follows the OS setting.
  const btn = document.getElementById('theme-toggle');
  const media = matchMedia('(prefers-color-scheme: dark)');
  const current = () => document.documentElement.dataset.theme || (media.matches ? 'dark' : 'light');
  const render = () => {
    const dark = current() === 'dark';
    btn.textContent = dark ? '☀' : '☾';
    btn.title = btn.ariaLabel = dark ? '라이트 모드로 변경' : '다크 모드로 변경';
  };
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch {}
    render();
  });
  media.addEventListener('change', render);
  render();
})();
</script>`;
};

// 업무 내역 (main page): searchable list of past runs, refreshed when a run starts or ends.
// A browser opens at most 6 connections to one host, and each open tab holds one /events stream, so a 7th tab
// would hang. Only the visible tab keeps the stream; a tab coming back reconnects, and onopen reloads its view.
const liveEvents = `function liveEvents(setup) {
  let es = null;
  const sync = () => {
    if (document.hidden) { if (es) es.close(); es = null; } else if (!es) { es = new EventSource('/events'); setup(es); }
  };
  document.addEventListener('visibilitychange', sync);
  sync();
}`;

const historyPage = (projects) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${favicon}<title>업무 내역 - 노션 개발 러너</title>
${style}
${gnb('history')}
<main>
<header class="title"><h1>업무 내역</h1><p>지금까지 실행한 업무를 검색하고 상태와 결과를 확인합니다.</p></header>
<section class="card">
<form id="search" role="search"><label>제목<input name="q" type="search" placeholder="제목으로 검색"></label>
<label>프로젝트<select name="project">${projectOptions(projects, '전체')}</select></label>
<label>날짜<input name="date" type="date"></label>
<button>검색</button><button type="reset" class="secondary">초기화</button></form>
<label id="list-size">페이지당 표시 개수<select id="page-size"><option value="10">10개</option><option value="20" selected>20개</option><option value="50">50개</option><option value="100">100개</option></select></label>
<table class="runs"><thead><tr><th>제목</th><th>프로젝트</th><th>Agent</th><th>상태</th><th>시작</th></tr></thead><tbody id="runs"></tbody></table>
<p id="runs-note" role="status"></p>
<nav id="pager" aria-label="업무 내역 페이지" hidden><button id="prev" type="button" class="secondary">이전</button><span id="page-info"></span><button id="next" type="button" class="secondary">다음</button></nav></section>
</main>
<script>
const runsEl = document.getElementById('runs');
const runsNote = document.getElementById('runs-note');
const searchForm = document.getElementById('search');
const pager = document.getElementById('pager');
const prev = document.getElementById('prev');
const next = document.getElementById('next');
const pageInfo = document.getElementById('page-info');
const pageSizeSelect = document.getElementById('page-size');
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
    params.set('pageSize', pageSizeSelect.value);
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
    runsNote.textContent = runs.length ? '' : (filter.size ? '검색 결과가 없습니다.' : '업무 내역이 없습니다.');
    runsEl.replaceChildren(...runs.map((r) => {
      const link = document.createElement('a');
      link.href = '/runs/' + r.id;
      link.textContent = r.title;
      const badge = document.createElement('span');
      badge.className = 'badge ' + r.status;
      badge.textContent = r.statusLabel;
      const row = document.createElement('tr');
      for (const content of [link, r.alias || r.project, r.agentLabel, badge, new Date(r.started_at).toLocaleString()]) {
        row.insertCell().append(content);
      }
      return row;
    }));
  } catch {
    if (load === latestLoad) runsNote.textContent = '업무 내역을 불러오지 못했습니다.';
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
pageSizeSelect.onchange = () => { currentPage = 1; loadRuns(); };
prev.onclick = () => { currentPage -= 1; loadRuns(); };
next.onclick = () => { currentPage += 1; loadRuns(); };
// The list only follows run changes; log lines are for the 업무 실행 page.
${liveEvents}
liveEvents((es) => {
  es.onopen = loadRuns;
  es.addEventListener('runs', loadRuns);
});
</script></html>`;

// 업무 실행: start a run and follow its time bars and live log.
const executePage = (projects) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${favicon}<title>업무 실행 - 노션 개발 러너</title>
${style}
${gnb('execute')}
<main>
<header class="brand"><h1>업무 실행</h1><p>노션 문서의 지시대로 새 브랜치에서 개발하고 결과를 문서에 정리합니다.</p></header>
<div class="workspace">
<section class="card request"><h2>새 업무 설정</h2>
<form id="f"><label>프로젝트<select name="project" required>${projectOptions(projects)}</select></label>
<label>실행 Agent<select name="agent">${Object.entries(AGENTS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
<label class="url">노션 링크<input name="url" type="url" placeholder="https://www.notion.so/..."></label>
<label class="task">업무 내용 추가<textarea name="task" rows="4" maxlength="${MAX_TASK_LENGTH}" aria-describedby="task-hint" placeholder="예: 주문 목록에 검색 기능 추가"></textarea>
<span class="hint" id="task-hint">노션 링크가 없으면 이 내용으로 개발합니다. 둘 다 입력하면 노션 문서의 지시에 더해 반영합니다.</span></label>
<div class="submit"><span>Ctrl + Enter로 시작</span><button>시작</button></div></form>
<p id="status" role="status"></p>
</section>
<div id="timeline">${emptyTimeline}</div>
<details class="card" id="log-card" open><summary><h2>실시간 로그</h2></summary><pre id="log" aria-live="polite"></pre></details>
</div>
</main>
<script>
const log = document.getElementById('log');
// A collapsed log cannot scroll, so catch up on the lines that arrived meanwhile.
document.getElementById('log-card').addEventListener('toggle', (e) => { if (e.target.open) log.scrollTop = log.scrollHeight; });
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
  // Scoped to the list: the legend also has an active swatch.
  if (timelineEl.querySelector('.timeline .bar.active')) scheduleTimeline(2000);
}
// Same grouping as the detail page, so the whole log is redrawn as lines arrive.
${groupLog.toString()}
let lines = [];
const showLog = () => { log.textContent = lines.length ? groupLog(lines).join('\\n') + '\\n' : ''; };
const status = document.getElementById('status');
${liveEvents}
liveEvents((es) => {
  es.onopen = () => { lines = []; showLog(); loadTimeline(); };
  es.addEventListener('runs', () => scheduleTimeline(100));
  es.onmessage = (e) => {
    scheduleTimeline(300);
    const text = JSON.parse(e.data);
    if (text.startsWith('시작: ')) lines = [];
    lines.push(text);
    showLog();
    log.scrollTop = log.scrollHeight;
  };
});
const runForm = document.getElementById('f');
// The last chosen AI stays selected next time.
try { const agent = localStorage.getItem('agent'); if ([...runForm.elements.agent.options].some((o) => o.value === agent)) runForm.elements.agent.value = agent; } catch {}
runForm.elements.agent.addEventListener('change', () => { try { localStorage.setItem('agent', runForm.elements.agent.value); } catch {} });
runForm.elements.task.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runForm.requestSubmit(); }
});
runForm.onsubmit = async (e) => {
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

// 프로젝트 관리: one column per group, one card per project folder. Cards are saved one at a time
// through the existing /projects API, which accepts any subset of folders.
const COLUMN_COLORS = ['#43a876', '#edbd38', '#9b7be0', '#345fc7', '#e07b7b', '#3aa6b9'];

const projectCard = (row, groups, stat, isGit) => {
  const last = stat?.last ? runView({ status: stat.last }) : null;
  const meta = [
    last && `<span class="s-${escapeHtml(last.status)}">최근 ${escapeHtml(last.statusLabel)}</span>`,
    `<span>${stat?.total ? `업무 ${stat.total}건` : '기록 없음'}</span>`,
    isGit ? '' : '<span>git 아님</span>',
  ].filter(Boolean).join('');
  return `<article class="pcard" draggable="true" data-name="${escapeHtml(row.name)}" data-group="${escapeHtml(row.group)}" data-search="${escapeHtml(`${row.name} ${row.alias}`.toLowerCase())}">
<div class="pc-head"><strong class="alias${row.alias ? '' : ' empty'}">${escapeHtml(row.alias || '별칭 없음')}</strong><button type="button" class="link edit" aria-label="${escapeHtml(row.name)} 편집">편집</button></div>
<div class="folder">${escapeHtml(row.name)}</div>
<div class="meta">${meta}</div>
<form class="editor" hidden><label>별칭<input name="alias" maxlength="50" value="${escapeHtml(row.alias)}"></label>
<label>그룹<select name="group">${groupOptions(groups, row.group)}</select></label>
<div class="row"><button>저장</button><button type="button" class="secondary cancel">취소</button></div></form>
</article>`;
};

const projectsPage = ({ rows, groups }, stats, isGit) => {
  const column = (group, label, color) => {
    const cards = rows.filter((r) => r.group === group);
    return `<section class="col" data-group="${escapeHtml(group)}" aria-label="${escapeHtml(label)} 그룹">
<header class="colhead"><i class="colmark" style="background:${color}"></i><h2>${escapeHtml(label)}</h2><span class="count">${cards.length}</span>${group ? `<button type="button" class="link del" data-group="${escapeHtml(group)}" aria-label="${escapeHtml(label)} 그룹 삭제">삭제</button>` : ''}</header>
<div class="cards">${cards.map((r) => projectCard(r, groups, stats.get(r.name), isGit(r.name))).join('')}</div>
<p class="drop">여기로 끌어 놓기</p></section>`;
  };
  return `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${favicon}<title>프로젝트 관리 - 노션 개발 러너</title>
${style}
${gnb('projects')}
<main>
<div class="board-top"><header class="title"><h1>프로젝트 관리</h1><p>카드를 다른 그룹으로 끌어 옮기고, 편집을 눌러 별칭과 그룹을 바꿉니다.</p></header>
<div class="board-tools"><input id="board-search" type="search" placeholder="폴더명이나 별칭으로 찾기" aria-label="프로젝트 찾기"><a class="button secondary" href="/projects">폴더 다시 읽기</a></div></div>
<p id="board-note" class="note" role="status"></p>
<div class="board">
${groups.map((g, i) => column(g, g, COLUMN_COLORS[i % COLUMN_COLORS.length])).join('')}
${column('', UNGROUPED, 'var(--bar-stopped)')}
<form id="group-form" class="newcol"><label>+ 새 그룹<input name="name" maxlength="50" required placeholder="그룹 이름 (50자 이내)"></label><button>그룹 추가</button></form>
</div>
<p class="muted">그룹을 삭제하면 그 그룹의 프로젝트는 ${UNGROUPED}로 옮겨집니다. 업무 실행에는 계속 실제 폴더명을 씁니다.</p>
</main>
<script>
const note = document.getElementById('board-note');
const say = (kind, text) => { note.className = 'note ' + kind; note.textContent = text; };
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res;
}
const columnOf = (group) => [...document.querySelectorAll('.col')].find((c) => c.dataset.group === group);
const recount = () => { for (const c of document.querySelectorAll('.col')) c.querySelector('.count').textContent = c.querySelectorAll('.pcard').length; };
// Saves one card, then moves it to its group's column; nothing on the page changes if the save fails.
async function saveCard(card, alias, group) {
  try {
    await post('/projects', [{ name: card.dataset.name, alias, group }]);
  } catch (err) {
    say('err', '저장하지 못했습니다. ' + err.message);
    return false;
  }
  const title = card.querySelector('.alias');
  title.textContent = alias.trim() || '별칭 없음';
  title.classList.toggle('empty', !alias.trim());
  card.querySelector('[name=alias]').defaultValue = alias.trim();
  // Defaults too, so a later 취소 (form reset) returns to the saved values.
  for (const option of card.querySelector('[name=group]').options) option.defaultSelected = option.value === group;
  card.dataset.group = group;
  card.dataset.search = (card.dataset.name + ' ' + alias.trim()).toLowerCase();
  columnOf(group).querySelector('.cards').append(card);
  recount();
  say('ok', '"' + card.dataset.name + '"을(를) 저장했습니다.');
  return true;
}
const closeEditor = (card) => {
  const form = card.querySelector('.editor');
  form.reset();
  form.hidden = true;
  card.classList.remove('editing');
  card.draggable = true;
};
document.querySelector('.board').addEventListener('click', async (e) => {
  const card = e.target.closest('.pcard');
  if (e.target.closest('.edit')) {
    for (const open of document.querySelectorAll('.pcard.editing')) if (open !== card) closeEditor(open);
    card.classList.add('editing');
    card.draggable = false;
    card.querySelector('.editor').hidden = false;
    card.querySelector('[name=alias]').focus();
  } else if (e.target.closest('.cancel')) {
    closeEditor(card);
  } else if (e.target.closest('.del')) {
    const name = e.target.closest('.del').dataset.group;
    if (!confirm('"' + name + '" 그룹을 삭제할까요? 이 그룹의 프로젝트는 ${UNGROUPED}로 옮겨집니다.')) return;
    try {
      await post('/groups/delete', { name });
      location.reload();
    } catch (err) {
      say('err', '삭제하지 못했습니다. ' + err.message);
    }
  }
});
document.querySelector('.board').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.id === 'group-form') {
    try {
      await post('/groups', { name: form.elements.name.value });
      location.reload();
    } catch (err) {
      say('err', '그룹을 추가하지 못했습니다. ' + err.message);
    }
    return;
  }
  const card = form.closest('.pcard');
  if (await saveCard(card, form.elements.alias.value, form.elements.group.value)) closeEditor(card);
});
// Drag and drop moves a card to another group; the editor's group select does the same without a mouse.
let dragged = null;
document.addEventListener('dragstart', (e) => {
  dragged = e.target.closest && e.target.closest('.pcard');
  if (dragged) { dragged.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
});
document.addEventListener('dragend', () => {
  if (dragged) dragged.classList.remove('dragging');
  dragged = null;
  for (const c of document.querySelectorAll('.col.over')) c.classList.remove('over');
});
for (const col of document.querySelectorAll('.col')) {
  col.addEventListener('dragover', (e) => { if (dragged) { e.preventDefault(); col.classList.add('over'); } });
  col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
  col.addEventListener('drop', async (e) => {
    e.preventDefault();
    col.classList.remove('over');
    const card = dragged;
    if (!card || card.dataset.group === col.dataset.group) return;
    await saveCard(card, card.querySelector('[name=alias]').defaultValue, col.dataset.group);
  });
}
document.getElementById('board-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  for (const card of document.querySelectorAll('.pcard')) card.hidden = Boolean(q) && !card.dataset.search.includes(q);
});
</script></html>`;
};

const BAR_LABELS = { active: '진행 중', done: '완료', failed: '실패', stopped: '중단됨' };
const barRow = (bar, attrs = '') => `<li${attrs}><span class="name">${escapeHtml(bar.name)}</span><span class="track"><span class="bar ${bar.state}" style="left:${bar.left}%;width:${bar.width}%"></span></span><span class="dur">${escapeHtml(bar.duration)}<span class="sr"> ${BAR_LABELS[bar.state]}</span></span></li>`;

// heading lets the home page name and link the run it is showing.
const timelineSection = (run, timeline, heading = '작업 시간') => `<section class="card"><h2>${heading}</h2>
${run.status === 'queued' ? '<p class="muted">아직 시작하지 않았습니다.</p>' : `<p class="legend" aria-hidden="true">${Object.entries(BAR_LABELS).map(([state, label]) => `<span><i class="bar ${state}"></i>${label}</span>`).join('')}</p>
<ol class="timeline">${barRow(timeline.total, ' class="total"')}${timeline.steps.map((bar) => barRow(bar)).join('')}</ol>
${timeline.steps.length ? '' : '<p class="muted">도구 기록이 없습니다. 이 기능을 넣기 전의 작업이거나 도구를 쓰지 않은 작업입니다.</p>'}`}
</section>`;

// Shown on the execute page before any run, so the card keeps its place.
const emptyTimeline = '<section class="card"><h2>작업 시간</h2><p class="muted">아직 실행한 업무가 없습니다. 업무를 시작하면 단계별 시간이 표시됩니다.</p></section>';

// timeline is null in the simple view.
const detailPage = (run, logs, alias, timeline) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${favicon}<title>${escapeHtml(run.title)}</title>
${['queued', 'running'].includes(run.status) ? '<meta http-equiv="refresh" content="3">' : ''}
${style}
${gnb('history')}
<main>
<a class="back" href="/">← 업무 내역</a>
<header class="title"><h1>${escapeHtml(run.title)}</h1><p>이 업무의 진행 상태, 작업 정보와 실행 로그를 확인합니다.</p><span class="badge ${escapeHtml(run.status)}">${escapeHtml(run.statusLabel)}</span></header>
<nav class="views" aria-label="보기 방식">${timeline
    ? `<a href="/runs/${run.id}">간단히</a><a href="?view=time" aria-current="page">자세히</a>`
    : `<a href="/runs/${run.id}" aria-current="page">간단히</a><a href="?view=time">자세히</a>`}</nav>
${timeline ? timelineSection(run, timeline) : ''}
<section class="card"><table class="meta">
<tr><th>프로젝트</th><td>${escapeHtml(alias ? `${alias} (${run.project})` : run.project)}</td></tr>
<tr><th>실행 Agent</th><td>${escapeHtml(run.agentLabel)}</td></tr>
<tr><th>브랜치</th><td>${escapeHtml(run.branch || '-')}</td></tr>
<tr><th>노션 문서</th><td>${run.url ? `<a href="${escapeHtml(run.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(run.url)}</a>` : '-'}</td></tr>
${run.task ? `<tr><th>업무 내용</th><td><div class="task-text">${escapeHtml(run.task)}</div></td></tr>` : ''}
<tr><th>시작</th><td><time datetime="${escapeHtml(run.started_at)}">${escapeHtml(run.started_at)}</time></td></tr>
<tr><th>종료</th><td>${run.finished_at ? `<time datetime="${escapeHtml(run.finished_at)}">${escapeHtml(run.finished_at)}</time>` : '-'}</td></tr>
</table></section>
<section class="card"><h2>작업 내용</h2><pre>${escapeHtml(groupLog(logs).join('\n'))}</pre></section>
</main>
<script>
for (const t of document.querySelectorAll('time')) t.textContent = new Date(t.dateTime).toLocaleString();
</script></html>`;

// The notion token reaches the MCP server through the environment (env_vars), never the command line.
function runCodex(prompt, cwd) {
  return spawn('codex', ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
    '-c', 'mcp_servers.notion.command="notion-mcp-server"', '-c', 'mcp_servers.notion.env_vars=["NOTION_TOKEN"]', prompt],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

const runAgent = (prompt, cwd, agent) => (agent === 'codex' ? runCodex : runClaude)(prompt, cwd);

function runClaude(prompt, cwd) {
  return spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--mcp-config', path.join(__dirname, 'mcp.json'), '--strict-mcp-config'],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function createApp({ root, start = runAgent, db = openDb(':memory:') }) {
  let current = null;
  // The home page keeps showing the last run's bars after it ends.
  let lastRunId = null;
  const queue = [];
  let log = [];
  const clients = new Set();
  // Every log line goes through this before it is shown or saved. Read per call, so a token set later counts too.
  const clean = (text) => maskSecrets(text, [process.env.NOTION_TOKEN]);
  const emit = (raw) => {
    const text = clean(raw);
    log.push(text);
    for (const c of clients) c.write(`data: ${JSON.stringify(text)}\n\n`);
  };
  const notifyRuns = () => {
    for (const c of clients) c.write('event: runs\ndata: {}\n\n');
  };
  // These run from stream callbacks, where a throw would take the whole server down mid-run.
  const record = (write) => {
    try { write(); } catch (err) { console.error(`업무 내역 저장 실패: ${err.message}`); }
  };

  const isRepo = (project) => fs.existsSync(path.join(root, project, '.git'));

  // Done when a run starts, not when it is queued: an earlier run may still be changing the same tree.
  // Async: git status on a big repo over the Windows bind mount can take minutes, and a sync call froze every page.
  async function createBranch(project) {
    const cwd = path.join(root, project);
    if (!isRepo(project)) throw new Error('git 저장소가 아닙니다.');
    const git = async (...args) => (await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
    if ((await git('status', '--porcelain')).trim()) throw new Error('커밋하지 않은 변경이 있습니다.');
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const base = `notion/${stamp}`;
    // A queued run can start within the same second when the one before it fails fast.
    let branch = base;
    for (let n = 2; (await git('branch', '--list', branch)).trim(); n += 1) branch = `${base}-${n}`;
    await git('switch', '-c', branch);
    return branch;
  }

  // A run that can't start is recorded as failed and the queue moves on, so one bad job doesn't block the rest.
  // While the branch is being made the job counts as current, so new requests queue behind it and duplicates are refused.
  async function startNext() {
    const job = queue.shift();
    if (!job) return;
    current = job;
    let branch;
    try {
      branch = await createBranch(job.project);
      db.startRun(job.runId, branch);
    } catch (err) {
      current = null;
      const message = `실패: ${err.message}`;
      emit(`${job.project} ${message}`);
      record(() => db.appendLog(job.runId, clean(message)));
      record(() => db.finishRun(job.runId, 'failed'));
      notifyRuns();
      startNext();
      return;
    }
    try {
      launch(job.runId, job, branch);
    } catch { /* launch already recorded the failure and moved on */ }
  }

  function launch(runId, { project, url, task, agent = 'claude' }, branch) {
    const cwd = path.join(root, project);
    const say = (raw) => {
      const text = clean(raw);
      record(() => db.appendLog(runId, text));
      emit(text);
    };
    current = { project, url, task };
    lastRunId = runId;
    log = [];
    say(`시작: ${project} (${branch}) · ${AGENTS[agent]}`);
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
      const template = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
      const prompt = buildPrompt({
        notionTemplate: url ? template('prompt.md') : '', taskTemplate: url ? '' : template('prompt-task.md'), url, task, branch,
      });
      child = start(prompt, cwd, agent);
    } catch (err) {
      finish('failed', `실패: ${err.message}`);
      throw err;
    }
    let buffered = '';
    const translate = agent === 'codex' ? codexTranslator() : (e) => [e];
    const steps = new Map();
    // One bar per tool call. The bar lasts until the next call starts; the result only marks a call as done.
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
        let events;
        try { events = translate(JSON.parse(line)); } catch { say(line); continue; }
        for (const e of events) {
          trackSteps(e);
          if (e.type === 'result') {
            result = e;
            const summary = extractSummary(e.result);
            if (summary) record(() => db.setSummary(runId, clean(summary)));
          }
          const text = formatEvent(JSON.stringify(e));
          if (text) say(text);
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (t) => say(t.trimEnd()));
    child.on('error', (err) => finish('failed', `실패: ${err.message}`));
    child.on('close', (code) => {
      if (code === 0 && result && !result.is_error) finish('success', url ? '완료: 브랜치와 노션 문서를 확인하세요.' : '완료: 브랜치와 작업 내용의 정리를 확인하세요.');
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

    // no-store: returning from the management page must show the saved project names.
    if (req.method === 'GET' && req.url === '/') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(historyPage(projects()));
    }
    if (req.method === 'GET' && req.url === '/execute') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(executePage(projects()));
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
        .end(run ? timelineSection(runView(run), timelineView(run, db.getSteps(run.id)), heading) : emptyTimeline);
    }
    if (req.method === 'GET' && pathname === '/projects') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(projectsPage(projects(), db.projectStats(), isRepo));
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
        .end(detailPage(runView(run), db.getLogs(run.id).map(clean), db.getProjectSettings(run.project)?.alias, timeline));
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
      const request = parseRunRequest(input);
      if (request.error) return send(400, request.error);
      const { url, task, agent } = request;
      const job = { project: input.project, url, task, agent };
      // Only a notion link needs the token; a task-only run never touches notion.
      if (url && start === runAgent && !process.env.NOTION_TOKEN) return send(400, 'NOTION_TOKEN이 설정되지 않았습니다.');
      // Also what stops a double click from running the same request twice.
      const same = (other) => other.project === job.project && other.url === url && other.task === task;
      if ((current && same(current)) || queue.some(same)) return send(409, '같은 작업이 이미 실행 중이거나 대기 중입니다.');
      try {
        if (!isRepo(input.project)) return send(400, 'git 저장소가 아닙니다.');
        // Every run goes through the queue, so the slow branch check never holds up this response.
        const busy = Boolean(current);
        const runId = db.enqueueRun(job);
        queue.push({ runId, ...job });
        notifyRuns();
        if (!busy) {
          startNext();
          return send(202, '시작 준비 중입니다. 변경 사항을 확인하고 브랜치를 만든 뒤 시작합니다. 결과는 실시간 로그와 업무 내역에 표시됩니다.');
        }
        return send(202, `대기 중입니다. 앞선 작업이 끝나면 순서대로 시작합니다. (대기 ${queue.length}번째)`);
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
