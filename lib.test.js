const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const {
  isValidProject, parseNotionUrl, isLocalRequest, extractSummary, parseRunFilter, parseRunRequest, buildPrompt,
} = require('./lib');
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
    assert.ok(html.includes('<option value="repo">repo</option>') && html.includes('<option value="plain">plain</option>'));
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
    const timeline = await (await fetch(`${base}/runs/${runs[0].id}?view=time`)).text();
    const live = await (await fetch(`${base}/timeline`)).text();
    const again = await post();
    return { res, runs, detail, timeline, live, again };
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

test('tool calls are timed and shown as bars in the detailed view', async () => {
  const { runs, detail, timeline, live } = await recordRun(node(`
    const say = (o) => console.log(JSON.stringify(o));
    say({type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Read<x>',input:{file_path:'secret.txt'}}]}});
    setTimeout(() => {
      say({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'top secret'}]}});
      say({type:'assistant',message:{content:[{type:'tool_use',id:'t2',name:'Bash',input:{command:'echo hidden'}}]}});
      say({type:'result',is_error:false});
    }, 150);`));
  assert.ok(!detail.includes('class="timeline"'), 'simple view has no bars');
  assert.ok(detail.includes('href="?view=time"'), 'simple view links to the detailed view');
  assert.match(timeline, /<li><span class="name">Read&#60;x&#62;<\/span><span class="track"><span class="bar done"/);
  assert.match(timeline, /<span class="name">명령 실행<\/span><span class="track"><span class="bar stopped"/, 'a call with no result is not shown as done');
  assert.match(timeline, /class="total"><span class="name">전체<\/span><span class="track"><span class="bar done"/);
  for (const hidden of ['secret.txt', 'top secret', 'echo hidden']) assert.ok(!timeline.includes(hidden), `${hidden} is not shown`);
  assert.ok(live.includes('<span class="name">Read&#60;x&#62;</span>'), 'home page fragment shows the same bars');
  assert.ok(live.includes(`href="/runs/${runs[0].id}?view=time"`), 'home page fragment links to the run');
  assert.ok(!live.includes('<html'), 'home page gets a fragment, not a page');
});

test('home page has a live timeline that is empty before any run', async () => {
  const app = createApp({ root: tmp });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.ok((await (await fetch(base)).text()).includes('id="timeline"'));
    const res = await fetch(`${base}/timeline`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), '');
  } finally {
    app.closeAllConnections();
    app.close();
  }
});

test('step bars run until the next step starts, so they add up to the total', () => {
  const { timelineView } = require('./lib');
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const run = { status: 'success', started_at: at(0), finished_at: at(20) };
  const view = timelineView(run, [
    { name: 'Read', started_at: at(2), finished_at: at(3) },
    { name: 'Grep', started_at: at(6), finished_at: at(7) },
    { name: 'Edit', started_at: at(6), finished_at: at(7) },
    { name: 'Bash', started_at: at(12), finished_at: at(15) },
  ]);
  assert.deepStrictEqual(view.steps.map((b) => [b.name, b.duration, b.state]), [
    ['시작 준비', '2.0초', 'done'], ['파일 읽기', '4.0초', 'done'], ['파일 내용 검색', '0.0초', 'done'],
    ['파일 고치기', '6.0초', 'done'], ['명령 실행', '8.0초', 'done'],
  ]);
  const seconds = (b) => Number.parseFloat(b.duration);
  assert.strictEqual(view.steps.reduce((sum, b) => sum + seconds(b), 0), 20);
  assert.strictEqual(view.total.duration, '20초');
  const widths = view.steps.filter((b) => seconds(b) > 0).reduce((sum, b) => sum + b.width, 0);
  assert.ok(Math.abs(widths - 100) < 1e-9, 'bars fill the whole track');
  const late = timelineView(run, [{ name: 'Read', started_at: at(30), finished_at: at(31) }]);
  assert.ok(late.steps.every((b) => b.left + b.width <= 100), 'a call after the run end stays inside');
  assert.deepStrictEqual(timelineView(run, []).steps, [], 'no calls, no rows');
});

test('tool names are shown in plain Korean in the live log', () => {
  const { formatEvent, toolLabel } = require('./lib');
  const tool = (name) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: { command: 'secret' } }] } });
  assert.strictEqual(formatEvent(tool('Bash')), '[도구] 명령 실행');
  assert.strictEqual(formatEvent(tool('mcp__notion__API-patch-block-children')), '[도구] 노션 페이지에 내용 추가');
  assert.strictEqual(toolLabel('mcp__notion__API-new-thing'), '노션 작업');
  assert.strictEqual(toolLabel('mcp__my_db__query'), 'my_db 연결 기능 (query)');
  assert.strictEqual(toolLabel('Unknown'), 'Unknown');
  assert.strictEqual(toolLabel('constructor'), 'constructor');
  assert.strictEqual(formatEvent(JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] })), '작업 환경을 준비했습니다.');
  assert.strictEqual(formatEvent(JSON.stringify({ type: 'system', subtype: 'other' })), null);
  assert.strictEqual(formatEvent('plain text'), 'plain text');
});

test('timeline bars stay inside the run and show live state', () => {
  const { timelineView, formatDuration } = require('./lib');
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const run = { status: 'running', started_at: at(0), finished_at: null };
  const steps = [
    { name: 'Read', started_at: at(0), finished_at: at(5) },
    { name: 'Bash', started_at: at(5), finished_at: null },
  ];
  const view = timelineView(run, steps, Date.parse(at(10)));
  assert.deepStrictEqual(view.total, { name: '전체', state: 'active', duration: '10초', left: 0, width: 100 });
  assert.deepStrictEqual(view.steps[0], { name: '파일 읽기', state: 'done', duration: '5.0초', left: 0, width: 50 });
  assert.deepStrictEqual(view.steps[1], { name: '명령 실행', state: 'active', duration: '5.0초', left: 50, width: 50 });
  const done = timelineView({ ...run, status: 'failed', finished_at: at(8) }, steps, Date.parse(at(99)));
  assert.strictEqual(done.total.state, 'failed');
  assert.deepStrictEqual(done.steps[1], { name: '명령 실행', state: 'stopped', duration: '3.0초', left: 62.5, width: 37.5 });
  const tiny = timelineView({ ...run, status: 'success', finished_at: at(100) }, [{ name: 'x', started_at: at(100), finished_at: at(100) }]);
  assert.ok(tiny.steps[0].width > 0 && tiny.steps[0].left + tiny.steps[0].width <= 100, 'a zero-length call is still visible inside the track');
  assert.deepStrictEqual([0.4, 12, 185, 3725].map((s) => formatDuration(s * 1000)), ['0.4초', '12초', '3분 5초', '1시간 2분']);
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
    const timeline = await (await fetch(`${base}/runs/${id}?view=time`)).text();
    assert.ok(timeline.includes('도구 기록이 없습니다'), 'runs without tool calls say so');
    assert.ok(timeline.includes('http-equiv="refresh"'), 'detailed view of a running run keeps refreshing');
    assert.strictEqual((await fetch(`${base}/runs/${id}?view=<b>`)).status, 200, 'an unknown view falls back to the simple one');
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
  assert.deepStrictEqual(parse(''), { q: '', project: '', from: '', to: '', page: 1 });
  assert.deepStrictEqual(parse('q=%20a%20&page=2'), { q: 'a', project: '', from: '', to: '', page: 2 });
  assert.strictEqual(parse('from=2026-01-01'), null);
});

test('project settings are validated, grouped and escaped', () => {
  const names = ['a', 'b', 'c'];
  const { parseProjectSettings, projectView, projectOptions, parseGroupName, groupOptions, groupItems } = require('./lib');
  const row = (over) => ({ name: 'a', alias: '', group: '', ...over });
  const parse = (input) => parseProjectSettings(input, names, ['팀']);
  assert.deepStrictEqual(parse([row({ alias: ' x ', group: '미분류' })]), [{ name: 'a', alias: 'x', group: '' }]);
  assert.deepStrictEqual(parse([row({ group: ' 팀 ' })]), [{ name: 'a', alias: '', group: '팀' }]);
  for (const bad of [null, {}, [null], [row({ name: '../a' })], [row({ alias: 1 })], [row({ alias: 'x'.repeat(51) })], [row({ group: '없는 그룹' })]]) {
    assert.strictEqual(parse(bad), null);
  }
  assert.strictEqual(parseGroupName(' 팀 '), '팀');
  for (const bad of [undefined, 1, '', '  ', '미분류', 'x'.repeat(51)]) assert.strictEqual(parseGroupName(bad), null);
  const view = projectView(names, [
    { name: 'a', alias: '<A>', group_name: '팀' },
    { name: 'gone', alias: 'x', group_name: '다른 팀' },
  ], ['팀', '빈 그룹']);
  assert.deepStrictEqual(view.groups, ['빈 그룹', '팀']);
  const html = projectOptions(view);
  assert.ok(html.includes('<optgroup label="팀"><option value="a">&#60;A&#62;</option></optgroup>'));
  assert.ok(html.includes('<optgroup label="미분류"><option value="b">b</option><option value="c">c</option></optgroup>'));
  assert.ok(!html.includes('빈 그룹'), 'a group with no projects adds nothing to the run form');
  assert.strictEqual(groupOptions(['<팀>'], '<팀>'), '<option value="">미분류</option><option value="&#60;팀&#62;" selected>&#60;팀&#62;</option>');
  assert.ok(!groupItems(['<팀>']).includes('<팀>'));
});

test('project settings save, survive a restart and only change labels', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-db-')), 'runner.db');
  let db = openDb(file);
  const runId = db.createRun({ project: 'repo', url: 'https://www.notion.so/a', branch: 'b' });
  const app = createApp({ root: tmp, db });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const save = (body, origin = base) => fetch(`${base}/projects`, {
    method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body),
  });
  try {
    db.addGroup('팀');
    assert.strictEqual((await save([], 'https://evil.com')).status, 403);
    assert.strictEqual((await save([{ name: '../x', alias: 'a', group: '' }])).status, 400);
    assert.strictEqual((await save([{ name: 'repo', alias: 'a', group: '없는 그룹' }])).status, 400);
    assert.strictEqual(db.getProjectSettings('repo'), undefined);
    const saved = await save([{ name: 'repo', alias: '<저장소>', group: '팀' }]);
    assert.strictEqual(saved.status, 200);
    const home = await (await fetch(base)).text();
    assert.ok(home.includes('<optgroup label="팀"><option value="repo">&#60;저장소&#62;</option>') && !home.includes('<저장소>'));
    const manage = await (await fetch(`${base}/projects`)).text();
    assert.ok(manage.includes('value="&#60;저장소&#62;"') && !manage.includes('<저장소>'));
    assert.ok(manage.includes('<option value="팀" selected>'));
    const detail = await (await fetch(`${base}/runs/${runId}`)).text();
    assert.ok(detail.includes('&#60;저장소&#62; (repo)'));
  } finally {
    app.closeAllConnections();
    app.close();
  }
  db.close();
  db = openDb(file);
  assert.strictEqual(db.getProjectSettings('repo').group_name, '팀');
  db.saveProjectSettings([{ name: 'repo', alias: '', group: '' }]);
  assert.strictEqual(db.getProjectSettings('repo').alias, null);
  db.close();
});

test('project management is its own page, linked from the home page', async () => {
  const app = createApp({ root: tmp });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const home = await fetch(base);
    assert.strictEqual(home.headers.get('cache-control'), 'no-store');
    const homeHtml = await home.text();
    assert.ok(homeHtml.includes('href="/projects"'));
    assert.ok(!homeHtml.includes('id="projects"') && !homeHtml.includes('name="alias"'));
    const manage = await (await fetch(`${base}/projects`)).text();
    assert.ok(manage.includes('id="projects"') && manage.includes('id="group-form"'));
    assert.ok(manage.includes('<select name="group"') && !manage.includes('datalist'));
    assert.ok(manage.includes('href="/"'));
  } finally {
    app.closeAllConnections();
    app.close();
  }
});

test('groups can be added and deleted, and deleting moves projects to ungrouped', async () => {
  const db = openDb(':memory:');
  const app = createApp({ root: tmp, db });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (url, body, origin = base) => fetch(base + url, {
    method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body),
  });
  try {
    assert.strictEqual((await post('/groups', { name: '팀' }, 'https://evil.com')).status, 403);
    assert.strictEqual((await post('/groups/delete', { name: '팀' }, 'https://evil.com')).status, 403);
    assert.strictEqual((await post('/groups', { name: '미분류' })).status, 400);
    assert.strictEqual((await post('/groups', null)).status, 400);
    const added = await post('/groups', { name: ' <팀> ' });
    assert.strictEqual(added.status, 200);
    const body = await added.json();
    assert.deepStrictEqual(body.groups, ['<팀>']);
    assert.ok(body.options.includes('value="&#60;팀&#62;"') && !body.items.includes('<팀>'));
    assert.strictEqual((await post('/groups', { name: '<팀>' })).status, 409);
    assert.strictEqual((await post('/groups', { name: '다른 팀' })).status, 200);

    // A group stays selectable even while no project uses it.
    assert.ok((await (await fetch(`${base}/projects`)).text()).includes('<option value="다른 팀">'));

    await post('/projects', [{ name: 'repo', alias: '별칭', group: '<팀>' }, { name: 'plain', alias: '', group: '다른 팀' }]);
    assert.strictEqual((await post('/groups/delete', { name: '없는 그룹' })).status, 404);
    assert.strictEqual((await post('/groups/delete', {})).status, 404);
    const deleted = await post('/groups/delete', { name: '<팀>' });
    assert.strictEqual(deleted.status, 200);
    assert.deepStrictEqual((await deleted.json()).groups, ['다른 팀']);
    assert.strictEqual(db.getProjectSettings('repo').group_name, null);
    assert.strictEqual(db.getProjectSettings('repo').alias, '별칭');
    assert.strictEqual(db.getProjectSettings('plain').group_name, '다른 팀');
  } finally {
    app.closeAllConnections();
    app.close();
    db.close();
  }
});

test('groups already on projects carry over, and a deleted one stays deleted after a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-db-')), 'runner.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE projects (name TEXT PRIMARY KEY, alias TEXT, group_name TEXT);
    INSERT INTO projects VALUES ('a', NULL, '팀'), ('b', NULL, '팀'), ('c', NULL, NULL);`);
  old.close();
  let db = openDb(file);
  assert.deepStrictEqual(db.listGroups(), ['팀']);
  assert.strictEqual(db.deleteGroup('팀'), true);
  db.close();
  db = openDb(file);
  assert.deepStrictEqual(db.listGroups(), []);
  assert.strictEqual(db.getProjectSettings('a').group_name, null);
  db.close();
});

// Fake runs that wait until told to end, so a test can decide when each one finishes.
async function queueApp(db = openDb(':memory:')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  for (const name of ['a', 'b', 'plain']) fs.mkdirSync(path.join(root, name));
  for (const name of ['a', 'b']) {
    const g = (...args) => execFileSync('git', args, { cwd: path.join(root, name), stdio: 'pipe' });
    g('init');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-m', 'init');
  }
  const started = [];
  const start = (prompt, cwd) => {
    const child = spawn(process.execPath, ['-e', `
      console.log(JSON.stringify({type:'result',is_error:false}));
      process.stdin.on('data', () => process.exit(0));`], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    started.push({ prompt, project: path.basename(cwd), end: () => child.stdin.write('x') });
    return child;
  };
  const app = createApp({ root, db, start });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (project, page) => fetch(`${base}/run`, {
    method: 'POST', headers: { Origin: base },
    body: JSON.stringify({ project, url: `https://www.notion.so/${page}` }),
  });
  const list = async (query = '') => (await (await fetch(`${base}/runs${query}`)).json()).runs;
  const statuses = async () => (await list()).reverse().map((r) => r.status);
  const until = async (check) => {
    for (let i = 0; i < 200; i += 1) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail('timed out');
  };
  const close = () => { app.closeAllConnections(); app.close(); };
  return { root, base, post, list, statuses, started, until, close };
}

test('requests during a run wait and then run one at a time, in order', async () => {
  const t = await queueApp();
  try {
    assert.strictEqual((await t.post('a', 'one')).status, 202);
    const waiting = await t.post('b', 'two');
    assert.strictEqual(waiting.status, 202);
    assert.match(await waiting.text(), /대기 1번째/);
    assert.strictEqual((await t.post('a', 'three')).status, 202);
    assert.deepStrictEqual(await t.statuses(), ['running', 'queued', 'queued']);
    assert.strictEqual(t.started.length, 1, 'nothing else starts while the first runs');

    const queued = (await t.list())[1];
    assert.strictEqual(queued.statusLabel, '대기 중');
    assert.strictEqual(queued.title, 'b', 'a queued run has no branch to show yet');
    assert.strictEqual(queued.branch, '');
    const detail = await (await fetch(`${t.base}/runs/${queued.id}`)).text();
    assert.ok(detail.includes('http-equiv="refresh"'), 'a waiting page keeps refreshing');

    t.started[0].end();
    await t.until(async () => (await t.statuses()).join() === 'success,running,queued');
    assert.strictEqual(t.started.length, 2);
    assert.strictEqual(t.started[1].project, 'b');
    const second = (await t.list())[1];
    assert.ok(second.prompt === undefined && second.branch.startsWith('notion/'));
    assert.ok(t.started[1].prompt.includes('https://www.notion.so/two') && t.started[1].prompt.includes(second.branch));
    assert.ok(second.started_at >= (await t.list())[2].started_at, 'start time becomes the real start');

    t.started[1].end();
    await t.until(async () => (await t.statuses()).join() === 'success,success,running');
    t.started[2].end();
    await t.until(async () => (await t.statuses()).join() === 'success,success,success');
    assert.deepStrictEqual(t.started.map((s) => s.project), ['a', 'b', 'a']);
    assert.strictEqual((await t.post('a', 'four')).status, 202, 'an idle server starts right away');
    assert.strictEqual((await t.statuses()).at(-1), 'running');
    t.started[3].end();
    await t.until(async () => (await t.statuses()).at(-1) === 'success');
  } finally {
    t.close();
  }
});

test('a duplicate or non-repository request is not queued', async () => {
  const t = await queueApp();
  try {
    assert.strictEqual((await t.post('a', 'one')).status, 202);
    assert.strictEqual((await t.post('a', 'one')).status, 409, 'same as the running one');
    assert.strictEqual((await t.post('plain', 'two')).status, 400);
    assert.strictEqual((await t.post('b', 'two')).status, 202);
    assert.strictEqual((await t.post('b', 'two')).status, 409, 'same as a waiting one');
    assert.strictEqual((await t.post('b', 'one')).status, 202, 'same page in another project is different work');
    assert.strictEqual((await t.list()).length, 3);
    for (const name of ['b', 'b']) {
      t.started.at(-1).end();
      const count = t.started.length;
      await t.until(() => t.started.length > count);
      assert.strictEqual(t.started.at(-1).project, name);
    }
    t.started.at(-1).end();
    await t.until(async () => (await t.statuses()).every((s) => s === 'success'));
  } finally {
    t.close();
  }
});

test('a queued run that cannot start fails and the next one still runs', async () => {
  const t = await queueApp();
  try {
    await t.post('a', 'one');
    await t.post('a', 'two');
    await t.post('b', 'three');
    fs.writeFileSync(path.join(t.root, 'a', 'left-behind.txt'), 'x');
    t.started[0].end();
    await t.until(async () => (await t.statuses()).join() === 'success,failed,running');
    assert.strictEqual(t.started.length, 2);
    assert.strictEqual(t.started[1].project, 'b');
    const failed = (await t.list())[1];
    const detail = await (await fetch(`${t.base}/runs/${failed.id}`)).text();
    assert.ok(detail.includes('커밋하지 않은 변경이 있습니다.'));
    assert.ok(failed.finished_at);
    t.started[1].end();
    await t.until(async () => (await t.statuses()).at(-1) === 'success');
  } finally {
    t.close();
  }
});

test('queued runs that start within one second get different branches', async () => {
  const db = openDb(':memory:');
  const t = await queueApp(db);
  try {
    await t.post('a', 'one');
    await t.post('a', 'two');
    await t.post('a', 'three');
    for (const i of [0, 1, 2]) {
      await t.until(() => t.started.length > i);
      t.started[i].end();
    }
    await t.until(async () => (await t.statuses()).every((s) => s === 'success'));
    const branches = (await t.list()).map((r) => r.branch);
    assert.strictEqual(new Set(branches).size, 3, branches.join());
  } finally {
    t.close();
  }
});

test('waiting runs become interrupted after a restart and do not start by themselves', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-')), 'runner.db');
  const first = openDb(file);
  const id = first.enqueueRun({ project: 'repo', url: 'https://www.notion.so/a' });
  first.close();
  const second = openDb(file);
  const run = second.getRun(id);
  assert.strictEqual(run.status, 'interrupted');
  assert.ok(run.finished_at);
  second.close();
});

test('run list shows the project alias and filters by project', async () => {
  const db = openDb(':memory:');
  db.saveProjectSettings([{ name: 'a', alias: '별칭 A', group: '' }]);
  const url = 'https://www.notion.so/x';
  db.createRun({ project: 'a', url, branch: 'notion/1' });
  db.createRun({ project: 'b', url, branch: 'notion/2' });
  // Exact match: "a" must not also find a project whose name only contains it.
  db.createRun({ project: 'aa', url, branch: 'notion/3' });
  const t = await queueApp(db);
  try {
    const projectsOf = (runs) => runs.map((r) => r.project);
    assert.deepStrictEqual(projectsOf(await t.list()), ['aa', 'b', 'a']);
    const [only] = await t.list('?project=a');
    assert.strictEqual(only.project, 'a');
    assert.strictEqual(only.alias, '별칭 A');
    assert.deepStrictEqual(projectsOf(await t.list('?project=a')), ['a']);
    assert.strictEqual((await t.list('?project=b'))[0].alias, null);
    assert.deepStrictEqual(await t.list('?project=none'), []);
    assert.deepStrictEqual(projectsOf(await t.list('?project=a&q=notion/2')), []);
    const { total } = await (await fetch(`${t.base}/runs?project=b`)).json();
    assert.strictEqual(total, 1, 'the page count follows the filter');
    const html = await (await fetch(t.base)).text();
    assert.ok(html.includes('<th>프로젝트</th>'));
    assert.ok(html.includes('<select name="project"><option value="">전체</option>'));
    assert.ok(html.includes('<select name="project" required><option value="">선택하세요</option>'));
  } finally {
    t.close();
  }
});

test('a run needs a notion link, a task, or both', () => {
  assert.deepStrictEqual(parseRunRequest({ url: 'https://www.notion.so/a' }), { url: 'https://www.notion.so/a', task: '' });
  assert.deepStrictEqual(parseRunRequest({ url: '', task: '  검색 추가\n' }), { url: '', task: '검색 추가' });
  assert.deepStrictEqual(parseRunRequest({ url: 'https://www.notion.so/a', task: '더' }), { url: 'https://www.notion.so/a', task: '더' });
  for (const bad of [{}, null, { url: ' ', task: ' \n' }, { url: 1, task: [] }]) {
    assert.match(parseRunRequest(bad).error, /노션 링크나 업무 내용/, JSON.stringify(bad));
  }
  assert.match(parseRunRequest({ url: 'https://evil.com', task: '일' }).error, /노션 링크가 아닙니다/, 'a bad link is not silently dropped');
  assert.match(parseRunRequest({ task: 'x'.repeat(10001) }).error, /10000자/);
});

test('the prompt follows the notion page, the task, or both', () => {
  const notionTemplate = 'N {{URL}} {{BRANCH}}\n';
  const taskTemplate = 'T {{TASK}} {{BRANCH}}';
  const prompt = (url, task) => buildPrompt({ notionTemplate, taskTemplate, url, task, branch: 'notion/1' });
  assert.strictEqual(prompt('https://www.notion.so/a', ''), 'N https://www.notion.so/a notion/1\n');
  assert.strictEqual(prompt('', '검색 {{BRANCH}} $&'), 'T 검색 {{BRANCH}} $& notion/1', 'task text is inserted as is');
  const both = prompt('https://www.notion.so/a', '로그인 추가');
  assert.ok(both.startsWith('N https://www.notion.so/a notion/1\n\n추가 업무 내용'));
  assert.ok(both.trimEnd().endsWith('로그인 추가'));
});

test('a run can start from the task text alone and shows it on the detail page', async () => {
  const t = await queueApp();
  const post = (body) => fetch(`${t.base}/run`, { method: 'POST', headers: { Origin: t.base }, body: JSON.stringify(body) });
  try {
    const home = await (await fetch(t.base)).text();
    assert.ok(home.includes('<textarea name="task"') && !/name="url"[^>]*required/.test(home), 'the link is optional');
    assert.ok(home.indexOf('name="url"') < home.indexOf('name="task"'), 'the task box sits below the link');
    assert.strictEqual((await post({ project: 'a', url: '', task: '' })).status, 400);

    assert.strictEqual((await post({ project: 'a', url: '', task: '<b>검색</b> 추가' })).status, 202);
    assert.strictEqual((await post({ project: 'a', task: '<b>검색</b> 추가' })).status, 409, 'same task twice');
    assert.strictEqual((await post({ project: 'a', url: 'https://www.notion.so/p', task: '덧붙임' })).status, 202);
    const [prompt] = t.started.map((s) => s.prompt);
    assert.ok(prompt.includes('<b>검색</b> 추가') && !prompt.includes('{{'), 'the task template is filled');
    assert.ok(!prompt.includes('Notion MCP'), 'a task-only run does not ask for notion');

    const [both, alone] = await t.list();
    assert.strictEqual(alone.url, '');
    assert.strictEqual(both.task, '덧붙임');
    const detail = await (await fetch(`${t.base}/runs/${alone.id}`)).text();
    assert.ok(detail.includes('<th>업무 내용</th>') && detail.includes('&#60;b&#62;검색&#60;/b&#62; 추가'));
    assert.match(detail, /<th>노션 문서<\/th><td>-<\/td>/);

    t.started[0].end();
    await t.until(() => t.started.length === 2);
    assert.ok(t.started[1].prompt.includes('https://www.notion.so/p') && t.started[1].prompt.trimEnd().endsWith('덧붙임'));
    t.started[1].end();
    await t.until(async () => (await t.statuses()).every((s) => s === 'success'));
  } finally {
    t.close();
  }
});

test('an existing database gains an empty task column', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-db-')), 'runner.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, url TEXT NOT NULL,
    branch TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
    INSERT INTO runs (project, url, branch, status, started_at) VALUES ('p', 'u', 'b', 'success', '2026-01-01T00:00:00.000Z');`);
  old.close();
  const db = openDb(file);
  assert.strictEqual(db.getRun(1).task, '');
  db.close();
});
