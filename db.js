const { DatabaseSync } = require('node:sqlite');

const PAGE_SIZE = 20;
// A queued run has no branch yet.
const TITLE = "COALESCE(summary, project || COALESCE(' · ' || NULLIF(branch, ''), ''))";
const FILTER = `WHERE (:q = '' OR instr(lower(${TITLE}), lower(:q)) > 0)
  AND (:project = '' OR project = :project)
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
    -- Tool name only: inputs and results can hold secrets.
    CREATE TABLE IF NOT EXISTS run_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS run_steps_run_id ON run_steps(run_id);
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      alias TEXT,
      group_name TEXT
    );
    CREATE TABLE IF NOT EXISTS project_groups (
      name TEXT PRIMARY KEY
    );
    -- Groups used to exist only as a value on projects. Deleting a group clears those values, so this can't revive one.
    INSERT OR IGNORE INTO project_groups (name)
      SELECT DISTINCT group_name FROM projects WHERE group_name IS NOT NULL;
  `);
  // Databases created before summaries existed keep their rows; those fall back to the default title.
  if (!db.prepare('PRAGMA table_info(runs)').all().some((column) => column.name === 'summary')) {
    db.exec('ALTER TABLE runs ADD COLUMN summary TEXT');
  }
  // Task text typed on the 업무 실행 page. Older rows had only a notion link, so they get an empty task.
  if (!db.prepare('PRAGMA table_info(runs)').all().some((column) => column.name === 'task')) {
    db.exec("ALTER TABLE runs ADD COLUMN task TEXT NOT NULL DEFAULT ''");
  }
  // Which AI ran it. Rows from before the choice existed were all Claude.
  if (!db.prepare('PRAGMA table_info(runs)').all().some((column) => column.name === 'agent')) {
    db.exec("ALTER TABLE runs ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'");
  }
  // Tokens the agent used, filled in while the run goes. Older rows stay NULL and show no count.
  for (const column of ['input_tokens', 'output_tokens']) {
    if (!db.prepare('PRAGMA table_info(runs)').all().some((c) => c.name === column)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${column} INTEGER`);
    }
  }
  const now = () => new Date().toISOString();

  // A run can't outlive the server that started it, so "running" here means the server died mid-run.
  // The queue is gone with it too, and the tree may be left dirty, so waiting runs don't start by themselves.
  db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status IN ('running', 'queued')").run(now());

  const insertRun = db.prepare(
    "INSERT INTO runs (project, url, task, agent, branch, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
  );
  const insertQueued = db.prepare(
    "INSERT INTO runs (project, url, task, agent, branch, status, started_at) VALUES (?, ?, ?, ?, '', 'queued', ?)",
  );
  const markStarted = db.prepare("UPDATE runs SET status = 'running', branch = ?, started_at = ? WHERE id = ?");
  const insertLog = db.prepare('INSERT INTO run_logs (run_id, text) VALUES (?, ?)');
  const updateRun = db.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?');
  const updateTokens = db.prepare('UPDATE runs SET input_tokens = ?, output_tokens = ? WHERE id = ?');
  const updateSummary = db.prepare('UPDATE runs SET summary = ? WHERE id = ?');
  const countRuns = db.prepare(`SELECT COUNT(*) AS total FROM runs ${FILTER}`);
  const selectRuns = db.prepare(`SELECT runs.*, ${TITLE} AS title, projects.alias AS alias
    FROM runs LEFT JOIN projects ON projects.name = runs.project ${FILTER} ORDER BY runs.id DESC LIMIT :limit OFFSET :offset`);
  const selectRun = db.prepare(`SELECT *, ${TITLE} AS title FROM runs WHERE id = ?`);
  const selectLogs = db.prepare('SELECT text FROM run_logs WHERE run_id = ? ORDER BY id');
  const insertStep = db.prepare('INSERT INTO run_steps (run_id, name, started_at) VALUES (?, ?, ?)');
  const updateStep = db.prepare('UPDATE run_steps SET finished_at = ? WHERE id = ? AND finished_at IS NULL');
  const selectSteps = db.prepare('SELECT name, started_at, finished_at FROM run_steps WHERE run_id = ? ORDER BY id');
  const upsertProject = db.prepare(`INSERT INTO projects (name, alias, group_name) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET alias = excluded.alias, group_name = excluded.group_name`);
  const selectProjects = db.prepare('SELECT * FROM projects');
  const selectProjectStats = db.prepare(`SELECT project, COUNT(*) AS total,
    (SELECT status FROM runs AS last WHERE last.project = runs.project ORDER BY last.id DESC LIMIT 1) AS last
    FROM runs GROUP BY project`);
  const selectProject = db.prepare('SELECT * FROM projects WHERE name = ?');
  const selectGroups = db.prepare('SELECT name FROM project_groups');
  const insertGroup = db.prepare('INSERT OR IGNORE INTO project_groups (name) VALUES (?)');
  const removeGroup = db.prepare('DELETE FROM project_groups WHERE name = ?');
  const clearGroup = db.prepare('UPDATE projects SET group_name = NULL WHERE group_name = ?');
  const transaction = (work) => {
    db.exec('BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    // url is '' for a run started from the task text alone.
    createRun: ({ project, url, task = '', agent = 'claude', branch }) => Number(insertRun.run(project, url, task, agent, branch, now()).lastInsertRowid),
    // started_at holds the request time until the run really starts.
    enqueueRun: ({ project, url, task = '', agent = 'claude' }) => Number(insertQueued.run(project, url, task, agent, now()).lastInsertRowid),
    startRun: (runId, branch) => { markStarted.run(branch, now(), runId); },
    appendLog: (runId, text) => { insertLog.run(runId, text); },
    finishRun: (runId, status) => { updateRun.run(status, now(), runId); },
    setSummary: (runId, summary) => { updateSummary.run(summary, runId); },
    setTokens: (runId, { input, output }) => { updateTokens.run(input, output, runId); },
    // A page past the end (runs can shrink under a filter) shows the last page instead of nothing.
    listRuns: ({ q = '', project = '', from = '', to = '', page = 1, pageSize = PAGE_SIZE } = {}) => {
      if (![10, 20, 50, 100].includes(pageSize)) pageSize = PAGE_SIZE;
      const filter = { q, project, from, to };
      const { total } = countRuns.get(filter);
      const lastPage = Math.max(1, Math.ceil(total / pageSize));
      const current = Math.min(page, lastPage);
      const runs = selectRuns.all({ ...filter, limit: pageSize, offset: (current - 1) * pageSize });
      return { runs, total, page: current, pageSize };
    },
    getRun: (runId) => selectRun.get(runId),
    getLogs: (runId) => selectLogs.all(runId).map((row) => row.text),
    startStep: (runId, name) => Number(insertStep.run(runId, name, now()).lastInsertRowid),
    finishStep: (stepId) => { updateStep.run(now(), stepId); },
    getSteps: (runId) => selectSteps.all(runId),
    listProjectSettings: () => selectProjects.all(),
    // Per project: how many runs it has and the status of its latest one.
    projectStats: () => new Map(selectProjectStats.all().map((row) => [row.project, { total: row.total, last: row.last }])),
    getProjectSettings: (name) => selectProject.get(name),
    // All or nothing, so a failed save never leaves the form half applied.
    saveProjectSettings: (settings) => transaction(() => {
      for (const { name, alias, group } of settings) upsertProject.run(name, alias || null, group || null);
    }),
    listGroups: () => selectGroups.all().map((row) => row.name),
    // Both return false when nothing changed: the group already exists, or is already gone.
    addGroup: (name) => Number(insertGroup.run(name).changes) > 0,
    deleteGroup: (name) => transaction(() => {
      clearGroup.run(name);
      return Number(removeGroup.run(name).changes) > 0;
    }),
    close: () => db.close(),
  };
}

module.exports = { openDb };
