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

function parseNotionUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const ok = url.protocol === 'https:' && !url.username && !url.password
    && (['notion.so', 'www.notion.so', 'app.notion.com'].includes(host) || host.endsWith('.notion.site'));
  return ok ? url.href : null;
}

// Host blocks DNS rebinding; Origin blocks other websites posting to localhost.
function isLocalRequest(headers, port, requireOrigin) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(headers.host)) return false;
  if (!requireOrigin) return true;
  return headers.origin === `http://${headers.host}`;
}

// Tool names only: tool input/output could contain secrets.
function formatEvent(line) {
  let e;
  try { e = JSON.parse(line); } catch { return line; }
  if (e.type === 'assistant') {
    return (e.message?.content || [])
      .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? `[도구] ${c.name}` : ''))
      .filter(Boolean).join('\n') || null;
  }
  return null;
}

module.exports = { listProjects, escapeHtml, isValidProject, parseNotionUrl, isLocalRequest, formatEvent };
