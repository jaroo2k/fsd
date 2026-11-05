const { DatabaseSync } = require('node:sqlite');

const PAGE_SIZE = 20;
const TITLE = "COALESCE(summary, project || ' · ' || branch)";
const FILTER = `WHERE (:q = '' OR instr(lower(${TITLE}), lower(:q)) > 0)
  AND (:from = '' OR started_at >= :from) AND (:to = '' OR started_at < :to)`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      url TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_logs_run_id ON run_logs(run_id);
  `);
  // Databases created before summaries existed keep their rows; those fall back to the default title.
  if (!db.prepare('PRAGMA table_info(runs)').all().some((column) => column.name === 'summary')) {
    db.exec('ALTER TABLE runs ADD COLUMN summary TEXT');
  }
  const now = () => new Date().toISOString();

  // A run can't outlive the server that started it, so "running" here means the server died mid-run.
  db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());

  const insertRun = db.prepare(
    "INSERT INTO runs (project, url, branch, status, started_at) VALUES (?, ?, ?, 'running', ?)",
  );
  const insertLog = db.prepare('INSERT INTO run_logs (run_id, text) VALUES (?, ?)');
  const updateRun = db.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?');
  const updateSummary = db.prepare('UPDATE runs SET summary = ? WHERE id = ?');
  const countRuns = db.prepare(`SELECT COUNT(*) AS total FROM runs ${FILTER}`);
  const selectRuns = db.prepare(`SELECT *, ${TITLE} AS title FROM runs ${FILTER} ORDER BY id DESC LIMIT :limit OFFSET :offset`);
  const selectRun = db.prepare(`SELECT *, ${TITLE} AS title FROM runs WHERE id = ?`);
  const selectLogs = db.prepare('SELECT text FROM run_logs WHERE run_id = ? ORDER BY id');

  return {
    createRun: ({ project, url, branch }) => Number(insertRun.run(project, url, branch, now()).lastInsertRowid),
    appendLog: (runId, text) => { insertLog.run(runId, text); },
    finishRun: (runId, status) => { updateRun.run(status, now(), runId); },
    setSummary: (runId, summary) => { updateSummary.run(summary, runId); },
    // A page past the end (runs can shrink under a filter) shows the last page instead of nothing.
    listRuns: ({ q = '', from = '', to = '', page = 1 } = {}) => {
      const filter = { q, from, to };
      const { total } = countRuns.get(filter);
      const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const current = Math.min(page, lastPage);
      const runs = selectRuns.all({ ...filter, limit: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE });
      return { runs, total, page: current, pageSize: PAGE_SIZE };
    },
    getRun: (runId) => selectRun.get(runId),
    getLogs: (runId) => selectLogs.all(runId).map((row) => row.text),
    close: () => db.close(),
  };
}

module.exports = { openDb };
