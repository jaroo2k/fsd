const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { isValidProject, parseNotionUrl, isLocalRequest } = require('./lib');
const { createApp } = require('./server');
const { openDb } = require('./db');

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
    const runs = await (await fetch(`${base}/runs`)).json();
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
  assert.deepStrictEqual(db.listRuns().map((r) => r.id), [cut, done]);
  db.close();
});
