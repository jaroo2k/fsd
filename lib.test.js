const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { isValidProject, parseNotionUrl, isLocalRequest, extractSummary, parseRunFilter } = require('./lib');
const { createApp } = require('./server');
const { openDb } = require('./db');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
fs.mkdirSync(path.join(tmp, 'plain'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
git('init');
git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-m', 'init');

test('project must be an exact child directory', () => {
  assert.ok(isValidProject('repo', tmp));
  for (const bad of ['..\\x', '../repo', 'none', '', null]) assert.ok(!isValidProject(bad, tmp), String(bad));
});

test('only https notion hosts pass', () => {
  assert.ok(parseNotionUrl('https://www.notion.so/abc'));
  assert.ok(parseNotionUrl('https://me.notion.site/abc'));
  assert.ok(parseNotionUrl('https://app.notion.com/p/abc'));
  for (const bad of ['http://notion.so/a', 'https://app.notion.com.evil.com/a','https://notion.so.evil.com/a', 'https://evilnotion.site/a',
    'https://notion.so@evil.com/a', 'nope']) assert.ok(!parseNotionUrl(bad), bad);
});

test('host and origin must be local', () => {
  const host = '127.0.0.1:1';
  assert.ok(isLocalRequest({ host }, 1, false));
  assert.ok(isLocalRequest({ host, origin: `http://${host}` }, 1, true));
  assert.ok(!isLocalRequest({ host }, 1, true));
  assert.ok(!isLocalRequest({ host, origin: 'https://evil.com' }, 1, true));
  assert.ok(!isLocalRequest({ host: 'evil.com:1' }, 1, false));
});

test('server refuses unsafe runs and allows one at a time', async () => {
  let child;
  const start = () => (child = spawn(process.execPath, ['-e',
    "console.log(JSON.stringify({type:'result',is_error:false}));setTimeout(()=>{},300)"]));
  const app = createApp({ root: tmp, start });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (project, origin = base) => fetch(`${base}/run`, {
    method: 'POST', headers: { Origin: origin },
    body: JSON.stringify({ project, url: 'https://www.notion.so/a' }),
  });
  try {
    const html = await (await fetch(base)).text();
    assert.ok(html.includes('<option>repo</option>') && html.includes('<option>plain</option>'));
    assert.strictEqual((await post('repo', 'https://evil.com')).status, 403);
    assert.strictEqual((await post('plain')).status, 400);
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    assert.strictEqual((await post('repo')).status, 400);
    fs.rmSync(path.join(repo, 'dirty.txt'));

    assert.strictEqual((await post('repo')).status, 202);
    assert.match(git('branch', '--show-current'), /^notion\//);
    assert.strictEqual((await post('repo')).status, 409);
    await new Promise((r) => child.on('close', r));
  } finally {
    app.closeAllConnections();
    app.close();
  }
});

// Runs one job in its own repo and returns what the server recorded about it.
async function recordRun(start, db = openDb(':memory:')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(cwd);
  const g = (...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  g('init');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-m', 'init');

  let closed = Promise.resolve();
  const app = createApp({
    root,
    db,
    start: (...args) => {
      const child = start(...args);
      closed = new Promise((r) => child.on('close', r));
      return child;
    },
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const post = () => fetch(`${base}/run`, {
      method: 'POST', headers: { Origin: base },
      body: JSON.stringify({ project: 'repo', url: 'https://www.notion.so/a' }),
    });
    const res = await post();
    await closed;
    const { runs } = await (await fetch(`${base}/runs`)).json();
    const detail = await (await fetch(`${base}/runs/${runs[0].id}`)).text();
    const again = await post();
    return { res, runs, detail, again };
  } finally {
    app.closeAllConnections();
    app.close();
  }
}

const node = (script) => () => spawn(process.execPath, ['-e', script]);

test('successful run is listed with its status and log', async () => {
  const { runs, detail } = await recordRun(node(`
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'작업 <중>'}]}}));
    console.log(JSON.stringify({type:'result',is_error:false}));`));
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].status, 'success');
  assert.strictEqual(runs[0].statusLabel, '완료');
  assert.match(runs[0].title, /^repo · notion\//);
  assert.ok(runs[0].finished_at);
  assert.ok(detail.includes('작업 &#60;중&#62;'), 'log is escaped');
  assert.ok(!detail.includes('http-equiv="refresh"'), 'finished page stops refreshing');
});

test('failed exit, spawn error and sync throw are recorded as failed', async () => {
  const failed = await recordRun(node('process.exit(3)'));
  assert.strictEqual(failed.runs[0].status, 'failed');
  assert.ok(failed.detail.includes('실패: 종료 코드 3'));

  const noResult = await recordRun(node('process.exit(0)'));
  assert.strictEqual(noResult.runs[0].status, 'failed');

  const missing = await recordRun(() => spawn('definitely-not-a-command'));
  assert.strictEqual(missing.runs[0].status, 'failed');

  const thrown = await recordRun(() => { throw new Error('boom'); });
  assert.strictEqual(thrown.res.status, 400);
  assert.strictEqual(thrown.runs[0].status, 'failed');
  assert.notStrictEqual(thrown.again.status, 409, 'server is not stuck as running');
});

test('run detail page escapes stored values and 404s unknown ids', async () => {
  const db = openDb(':memory:');
  const id = db.createRun({ project: '<script>x</script>', url: 'https://www.notion.so/"a', branch: 'b' });
  const app = createApp({ root: tmp, db });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const res = await fetch(`${base}/runs/${id}`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('<script>x'));
    assert.ok(!html.includes('/"a'));
    assert.ok(html.includes('http-equiv="refresh"'), 'running page keeps refreshing');
    assert.strictEqual((await fetch(`${base}/runs/999`)).status, 404);
    assert.strictEqual((await fetch(`${base}/runs/abc`)).status, 404);
  } finally {
    app.closeAllConnections();
    app.close();
  }
});

test('event stream opens before any log line exists', async () => {
  const app = createApp({ root: tmp });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const controller = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${app.address().port}/events`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
    });
    assert.strictEqual(res.status, 200);
  } finally {
    controller.abort();
    app.closeAllConnections();
    app.close();
  }
});

test('runs survive a restart and unfinished ones become interrupted', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-db-')), 'runner.db');
  let db = openDb(file);
  const done = db.createRun({ project: 'p', url: 'u', branch: 'b1' });
  db.appendLog(done, '로그');
  db.finishRun(done, 'success');
  const cut = db.createRun({ project: 'p', url: 'u', branch: 'b2' });
  db.close();

  db = openDb(file);
  assert.strictEqual(db.getRun(done).status, 'success');
  assert.deepStrictEqual(db.getLogs(done), ['로그']);
  assert.strictEqual(db.getRun(cut).status, 'interrupted');
  assert.ok(db.getRun(cut).finished_at);
  assert.deepStrictEqual(db.listRuns().runs.map((r) => r.id), [cut, done]);
  db.close();
});

test('summary line is extracted from the final response', () => {
  assert.strictEqual(extractSummary('끝났습니다.\n\n작업 요약: 검색 추가'), '검색 추가');
  assert.strictEqual(extractSummary('**작업 요약:** `검색 추가`\n'), '검색 추가');
  assert.strictEqual(extractSummary('작업 요약: 처음\n작업 요약: 마지막'), '마지막');
  assert.strictEqual(extractSummary(`작업 요약: ${'가'.repeat(150)}`).length, 100);
  assert.strictEqual(extractSummary('작업 요약:\n다음 줄'), null);
  for (const none of ['요약 없음', '', undefined, null]) assert.strictEqual(extractSummary(none), null);
});

test('prompt asks for the summary line and the status change', () => {
  const prompt = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
  assert.ok(prompt.includes('`작업 요약: '));
  assert.ok(prompt.includes('`상태` 속성을 `완료`로'));
});

test('run title is the summary from the result, escaped on the detail page', async () => {
  const { runs, detail } = await recordRun(node(
    "console.log(JSON.stringify({type:'result',is_error:false,result:'끝\\n작업 요약: 검색 <추가>'}));",
  ));
  assert.strictEqual(runs[0].title, '검색 <추가>');
  assert.ok(detail.includes('<h1>검색 &#60;추가&#62;</h1>'));
});

test('notion link on the detail page opens a new window', async () => {
  const { detail } = await recordRun(node("console.log(JSON.stringify({type:'result',is_error:false}));"));
  assert.match(detail, /<a href="https:\/\/www\.notion\.so\/a" target="_blank" rel="noopener noreferrer">/);
});

test('an existing database gains summaries without losing rows', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-db-')), 'runner.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, url TEXT NOT NULL,
    branch TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
    INSERT INTO runs (project, url, branch, status, started_at) VALUES ('p', 'u', 'b', 'success', '2026-01-01T00:00:00.000Z');`);
  old.close();

  const db = openDb(file);
  assert.strictEqual(db.getRun(1).title, 'p · b');
  db.setSummary(1, '요약');
  assert.strictEqual(db.getRun(1).title, '요약');
  db.close();
  openDb(file).close();
});

test('run list pages by 20 and filters by title and time', async () => {
  const db = openDb(':memory:');
  const ids = [];
  for (let i = 1; i <= 45; i += 1) ids.push(db.createRun({ project: 'proj', url: 'u', branch: `b${i}` }));
  db.setSummary(ids[0], '100%_검색 ADD');
  const app = createApp({ root: tmp, db });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const list = async (query) => (await fetch(`${base}/runs?${new URLSearchParams(query)}`)).json();
  try {
    const first = await list({});
    assert.strictEqual(first.runs.length, 20);
    assert.strictEqual(first.total, 45);
    assert.strictEqual(first.runs[0].id, ids[44]);

    const third = await list({ page: 3 });
    assert.strictEqual(third.runs.length, 5);
    assert.strictEqual((await list({ page: 99 })).page, 3, 'past the end shows the last page');
    for (const page of ['0', '-1', 'abc']) assert.strictEqual((await list({ page })).page, 1, page);

    assert.deepStrictEqual((await list({ q: '검색 add' })).runs.map((r) => r.id), [ids[0]]);
    assert.strictEqual((await list({ q: '100%_' })).total, 1);
    assert.strictEqual((await list({ q: '%' })).total, 1, '% is not a wildcard');
    assert.strictEqual((await list({ q: 'proj · b45' })).total, 1, 'default titles are searchable');
    assert.strictEqual((await list({ q: '없는 제목' })).total, 0);

    const today = new Date();
    const later = new Date(today.getTime() + 86400000);
    const hour = 3600000;
    assert.strictEqual((await list({
      from: new Date(today.getTime() - hour).toISOString(), to: later.toISOString(),
    })).total, 45);
    assert.strictEqual((await list({ from: later.toISOString() })).total, 0);
    assert.strictEqual((await list({ to: new Date(today.getTime() - hour).toISOString() })).total, 0);
    assert.strictEqual((await fetch(`${base}//`)).status, 404, 'odd paths do not crash the server');
    assert.strictEqual((await fetch(`${base}/runs?from=yesterday`)).status, 400);
    assert.strictEqual((await fetch(`${base}/runs?to=${encodeURIComponent("' OR 1=1")}`)).status, 400);
  } finally {
    app.closeAllConnections();
    app.close();
  }
});

test('run filter parsing', () => {
  const parse = (query) => parseRunFilter(new URLSearchParams(query));
  assert.deepStrictEqual(parse(''), { q: '', from: '', to: '', page: 1 });
  assert.deepStrictEqual(parse('q=%20a%20&page=2'), { q: 'a', from: '', to: '', page: 2 });
  assert.strictEqual(parse('from=2026-01-01'), null);
});
