const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { listProjects, escapeHtml, isValidProject, parseNotionUrl, isLocalRequest, formatEvent, runView } = require('./lib');
const { openDb } = require('./db');

const style = `<style>body{font:16px system-ui;max-width:800px;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}
input,select{display:block;width:100%;box-sizing:border-box;padding:.5rem}button{padding:.5rem 1rem}
#status{font-weight:600}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #ddd;overflow-wrap:anywhere}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:1rem;font-size:.85rem;white-space:nowrap;background:#e5e5e5;color:#222}
.running{background:#cfe2ff;color:#052c65}.success{background:#d1e7dd;color:#0a3622}.failed{background:#f8d7da;color:#58151c}
pre{background:#111;color:#eee;padding:1rem;min-height:12rem;max-height:60vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}</style>`;

const page = (projects) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>노션 개발 러너</title>
${style}
<h1>노션 개발 러너</h1>
<form id="f"><label>프로젝트<select name="project" required><option value="">선택하세요</option>${projects.map((p) => `<option>${escapeHtml(p)}</option>`).join('')}</select></label>
<label>노션 링크<input name="url" type="url" required></label><button>시작</button></form>
<p id="status" role="status"></p>
<pre id="log" aria-live="polite"></pre>
<h2>작업 기록</h2>
<table><thead><tr><th>제목</th><th>상태</th><th>시작</th></tr></thead><tbody id="runs"></tbody></table>
<p id="runs-note"></p>
<script>
const log = document.getElementById('log');
const runsEl = document.getElementById('runs');
const runsNote = document.getElementById('runs-note');
async function loadRuns() {
  try {
    const res = await fetch('/runs');
    if (!res.ok) throw new Error();
    const runs = await res.json();
    runsNote.textContent = runs.length ? '' : '작업 기록이 없습니다.';
    runsEl.replaceChildren(...runs.map((r) => {
      const link = document.createElement('a');
      link.href = '/runs/' + r.id;
      link.textContent = r.title;
      const badge = document.createElement('span');
      badge.className = 'badge ' + r.status;
      badge.textContent = r.statusLabel;
      const row = document.createElement('tr');
      for (const content of [link, badge, new Date(r.started_at).toLocaleString()]) {
        row.insertCell().append(content);
      }
      return row;
    }));
  } catch {
    runsNote.textContent = '작업 기록을 불러오지 못했습니다.';
  }
}
const es = new EventSource('/events');
es.onopen = () => { log.textContent = ''; loadRuns(); };
es.addEventListener('runs', loadRuns);
const status = document.getElementById('status');
es.onmessage = (e) => {
  const text = JSON.parse(e.data);
  if (text.startsWith('시작: ')) log.textContent = '';
  log.textContent += text + '\\n';
  log.scrollTop = log.scrollHeight;
};
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const body = JSON.stringify(Object.fromEntries(new FormData(e.target)));
  status.textContent = '요청 중...';
  try {
    const res = await fetch('/run', { method: 'POST', body });
    status.textContent = (res.ok ? '' : '거부됨: ') + (await res.text());
  } catch {
    status.textContent = '서버에 연결하지 못했습니다.';
  }
};
</script></html>`;

const detailPage = (run, logs) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(run.title)}</title>
${run.status === 'running' ? '<meta http-equiv="refresh" content="3">' : ''}
${style}
<p><a href="/">← 목록</a></p>
<h1>${escapeHtml(run.title)}</h1>
<p><span class="badge ${escapeHtml(run.status)}">${escapeHtml(run.statusLabel)}</span></p>
<table>
<tr><th>프로젝트</th><td>${escapeHtml(run.project)}</td></tr>
<tr><th>브랜치</th><td>${escapeHtml(run.branch)}</td></tr>
<tr><th>노션 문서</th><td><a href="${escapeHtml(run.url)}" rel="noreferrer">${escapeHtml(run.url)}</a></td></tr>
<tr><th>시작</th><td><time datetime="${escapeHtml(run.started_at)}">${escapeHtml(run.started_at)}</time></td></tr>
<tr><th>종료</th><td>${run.finished_at ? `<time datetime="${escapeHtml(run.finished_at)}">${escapeHtml(run.finished_at)}</time>` : '-'}</td></tr>
</table>
<h2>작업 내용</h2>
<pre>${escapeHtml(logs.join('\n'))}</pre>
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
  let running = false;
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

  function run(project, url) {
    const cwd = path.join(root, project);
    if (!fs.existsSync(path.join(cwd, '.git'))) throw new Error('git 저장소가 아닙니다.');
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (git('status', '--porcelain').trim()) throw new Error('커밋하지 않은 변경이 있습니다.');
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const branch = `notion/${stamp}`;
    git('switch', '-c', branch);

    const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8')
      .replaceAll('{{URL}}', () => url).replaceAll('{{BRANCH}}', () => branch);
    const runId = db.createRun({ project, url, branch });
    const say = (text) => {
      record(() => db.appendLog(runId, text));
      emit(text);
    };
    running = true;
    log = [];
    say(`시작: ${project} (${branch})`);
    notifyRuns();

    let result = null;
    let finished = false;
    const finish = (status, message) => {
      if (finished) return;
      finished = true;
      running = false;
      say(message);
      record(() => db.finishRun(runId, status));
      notifyRuns();
    };
    let child;
    try {
      child = start(prompt, cwd);
    } catch (err) {
      finish('failed', `실패: ${err.message}`);
      throw err;
    }
    let buffered = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      const lines = (buffered + chunk).split('\n');
      buffered = lines.pop();
      for (const line of lines.filter(Boolean)) {
        try { const e = JSON.parse(line); if (e.type === 'result') result = e; } catch { /* plain text is shown as is */ }
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
    const send = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
    };
    const isPost = req.method === 'POST';
    if (!isLocalRequest(req.headers, port, isPost)) return send(403, '로컬 요청만 허용합니다.');

    if (req.method === 'GET' && req.url === '/') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(listProjects(root)));
    }
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      for (const text of log) res.write(`data: ${JSON.stringify(text)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    if (req.method === 'GET' && req.url === '/runs') {
      return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(db.listRuns().map(runView)));
    }
    const detail = req.method === 'GET' && req.url.match(/^\/runs\/(\d{1,15})$/);
    if (detail) {
      const run = db.getRun(Number(detail[1]));
      if (!run) return send(404, '없는 작업입니다.');
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(detailPage(runView(run), db.getLogs(run.id)));
    }
    if (!isPost || req.url !== '/run') return send(404, '없는 경로입니다.');

    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8').on('data', (chunk) => {
      body += chunk;
      if (body.length > 10000) { tooLarge = true; body = ''; }
    });
    req.on('end', () => {
      if (tooLarge) return send(413, '요청이 너무 큽니다.');
      let input;
      try { input = JSON.parse(body); } catch { return send(400, '잘못된 요청입니다.'); }
      if (!isValidProject(input?.project, root)) return send(400, '없는 프로젝트입니다.');
      const url = parseNotionUrl(input.url);
      if (!url) return send(400, '노션 링크가 아닙니다.');
      if (start === runClaude && !process.env.NOTION_TOKEN) return send(400, 'NOTION_TOKEN이 설정되지 않았습니다.');
      if (running) return send(409, '이미 실행 중입니다.');
      try {
        run(input.project, url);
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
