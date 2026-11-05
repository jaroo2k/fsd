const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { isValidProject, parseNotionUrl, isLocalRequest } = require('./lib');
const { createApp } = require('./server');

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
