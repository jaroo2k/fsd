const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { listProjects, escapeHtml, isValidProject, parseNotionUrl, isLocalRequest, formatEvent } = require('./lib');

const page = (projects) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>노션 개발 러너</title>
<style>body{font:16px system-ui;max-width:800px;margin:2rem auto;padding:0 1rem}label{display:block;margin:.75rem 0}
input,select{display:block;width:100%;box-sizing:border-box;padding:.5rem}button{padding:.5rem 1rem}
#status{font-weight:600}
pre{background:#111;color:#eee;padding:1rem;min-height:12rem;max-height:60vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>노션 개발 러너</h1>
<form id="f"><label>프로젝트<select name="project" required><option value="">선택하세요</option>${projects.map((p) => `<option>${escapeHtml(p)}</option>`).join('')}</select></label>
<label>노션 링크<input name="url" type="url" required></label><button>시작</button></form>
<p id="status" role="status"></p>
<pre id="log" aria-live="polite"></pre>
<script>
const log = document.getElementById('log');
const es = new EventSource('/events');
es.onopen = () => { log.textContent = ''; };
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

function runClaude(prompt, cwd) {
  return spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--mcp-config', path.join(__dirname, 'mcp.json'), '--strict-mcp-config'],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function createApp({ root, start = runClaude }) {
  let running = false;
  let log = [];
  const clients = new Set();
  const emit = (text) => {
    log.push(text);
    for (const c of clients) c.write(`data: ${JSON.stringify(text)}\n\n`);
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
    running = true;
    log = [];
    emit(`시작: ${project} (${branch})`);

    const child = start(prompt, cwd);
    let result = null;
    let finished = false;
    const finish = (message) => {
      if (finished) return;
      finished = true;
      running = false;
      emit(message);
    };
    let buffered = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      const lines = (buffered + chunk).split('\n');
      buffered = lines.pop();
      for (const line of lines.filter(Boolean)) {
        try { const e = JSON.parse(line); if (e.type === 'result') result = e; } catch { /* plain text is shown as is */ }
        const text = formatEvent(line);
        if (text) emit(text);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (t) => emit(t.trimEnd()));
    child.on('error', (err) => finish(`실패: ${err.message}`));
    child.on('close', (code) => finish(code === 0 && result && !result.is_error
      ? '완료: 브랜치와 노션 문서를 확인하세요.' : `실패: 종료 코드 ${code}`));
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
  createApp({ root }).listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${port}`);
  });
}

module.exports = { createApp };
