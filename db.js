const { DatabaseSync } = require('node:sqlite');

const LIST_LIMIT = 100;

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
  const now = () => new Date().toISOString();

  // A run can't outlive the server that started it, so "running" here means the server died mid-run.
  db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());

  const insertRun = db.prepare(
    "INSERT INTO runs (project, url, branch, status, started_at) VALUES (?, ?, ?, 'running', ?)",
  );
  const insertLog = db.prepare('INSERT INTO run_logs (run_id, text) VALUES (?, ?)');
  const updateRun = db.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?');
  const selectRuns = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?');
  const selectRun = db.prepare('SELECT * FROM runs WHERE id = ?');
  const selectLogs = db.prepare('SELECT text FROM run_logs WHERE run_id = ? ORDER BY id');

  return {
    createRun: ({ project, url, branch }) => Number(insertRun.run(project, url, branch, now()).lastInsertRowid),
    appendLog: (runId, text) => { insertLog.run(runId, text); },
    finishRun: (runId, status) => { updateRun.run(status, now(), runId); },
    listRuns: () => selectRuns.all(LIST_LIMIT),
    getRun: (runId) => selectRun.get(runId),
    getLogs: (runId) => selectLogs.all(runId).map((row) => row.text),
    close: () => db.close(),
  };
}

module.exports = { openDb };
