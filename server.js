/**
 * Local API server that reads/writes TodoDB.db (TodosTB).
 * Run: npm install && npm start
 * Then run the TodoApp in the browser - it will use this server and update the real database.
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const PORT = 3001;
const DB_PATH = path.join(__dirname, '..', 'TodoDB.db');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

let db;
try {
  db = new Database(DB_PATH);
  console.log('Opened TodoDB.db at', DB_PATH);
  // Ensure TodosTB and AuditTB exist so all endpoints work
  db.exec(`
    CREATE TABLE IF NOT EXISTS TodosTB (
      TaskID INTEGER PRIMARY KEY AUTOINCREMENT,
      Task TEXT NOT NULL CHECK(length(Task) <= 40),
      Date DATE,
      Time TIME,
      Completed INTEGER DEFAULT 0 CHECK(Completed IN (0, 1)),
      Notes TEXT CHECK(length(Notes) <= 70),
      CompletDateTime DATETIME DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_todostb_date ON TodosTB(Date);
    CREATE INDEX IF NOT EXISTS idx_todostb_completed ON TodosTB(Completed);

    CREATE TABLE IF NOT EXISTS AuditTB (
      AuditID INTEGER PRIMARY KEY AUTOINCREMENT,
      TaskID INTEGER NOT NULL,
      Task TEXT,
      Action TEXT NOT NULL CHECK(Action IN ('create', 'update', 'delete')),
      DateTime DATETIME NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_audittb_taskid ON AuditTB(TaskID);
    CREATE INDEX IF NOT EXISTS idx_audittb_datetime ON AuditTB(DateTime);
  `);

  // Migration: add ReminderMinutes to TodosTB if missing
  try {
    db.prepare('SELECT ReminderMinutes FROM TodosTB LIMIT 1').get();
  } catch (e) {
    db.exec('ALTER TABLE TodosTB ADD COLUMN ReminderMinutes INTEGER DEFAULT 0');
    console.log('Migrated TodosTB: added ReminderMinutes');
  }
  try {
    db.prepare('SELECT Reminder2Minutes FROM TodosTB LIMIT 1').get();
  } catch (e) {
    db.exec('ALTER TABLE TodosTB ADD COLUMN Reminder2Minutes INTEGER DEFAULT 0');
    console.log('Migrated TodosTB: added Reminder2Minutes');
  }
  try {
    db.prepare('SELECT Reminder3Minutes FROM TodosTB LIMIT 1').get();
  } catch (e) {
    db.exec('ALTER TABLE TodosTB ADD COLUMN Reminder3Minutes INTEGER DEFAULT 0');
    console.log('Migrated TodosTB: added Reminder3Minutes');
  }
  try {
    db.prepare('SELECT RemindersJSON FROM TodosTB LIMIT 1').get();
  } catch (e) {
    db.exec('ALTER TABLE TodosTB ADD COLUMN RemindersJSON TEXT');
    console.log('Migrated TodosTB: added RemindersJSON');
  }

  // Migration: remove FK from AuditTB if present (allows delete to work; audit rows stay after task delete)
  const fkList = db.prepare("PRAGMA foreign_key_list(AuditTB)").all();
  if (fkList.length > 0) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TRIGGER IF EXISTS tr_TodosTB_after_insert");
    db.exec("DROP TRIGGER IF EXISTS tr_TodosTB_after_update");
    db.exec("DROP TRIGGER IF EXISTS tr_TodosTB_after_delete");
    db.exec(`
      CREATE TABLE AuditTB_new (
        AuditID INTEGER PRIMARY KEY AUTOINCREMENT,
        TaskID INTEGER NOT NULL,
        Task TEXT,
        Action TEXT NOT NULL CHECK(Action IN ('create', 'update', 'delete')),
        DateTime DATETIME NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      INSERT INTO AuditTB_new SELECT * FROM AuditTB;
      DROP TABLE AuditTB;
      ALTER TABLE AuditTB_new RENAME TO AuditTB;
      CREATE INDEX IF NOT EXISTS idx_audittb_taskid ON AuditTB(TaskID);
      CREATE INDEX IF NOT EXISTS idx_audittb_datetime ON AuditTB(DateTime);
    `);
    db.exec(`
      CREATE TRIGGER tr_TodosTB_after_insert AFTER INSERT ON TodosTB FOR EACH ROW
      BEGIN INSERT INTO AuditTB (TaskID, Task, Action, DateTime) VALUES (NEW.TaskID, NEW.Task, 'create', datetime('now', 'localtime')); END;
      CREATE TRIGGER tr_TodosTB_after_update AFTER UPDATE ON TodosTB FOR EACH ROW
      BEGIN INSERT INTO AuditTB (TaskID, Task, Action, DateTime) VALUES (NEW.TaskID, NEW.Task, 'update', datetime('now', 'localtime')); END;
      CREATE TRIGGER tr_TodosTB_after_delete AFTER DELETE ON TodosTB FOR EACH ROW
      BEGIN INSERT INTO AuditTB (TaskID, Task, Action, DateTime) VALUES (OLD.TaskID, OLD.Task, 'delete', datetime('now', 'localtime')); END;
    `);
    db.exec("PRAGMA foreign_keys = ON");
    console.log("Migrated AuditTB: removed foreign key so deletes work");
  }

  console.log('TodosTB and AuditTB ready');
} catch (err) {
  console.error('Failed to open TodoDB.db:', err.message);
  process.exit(1);
}

// GET all todos
app.get('/todos', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT TaskID, Task, Date, Time, Completed, Notes, CompletDateTime, ReminderMinutes, Reminder2Minutes, Reminder3Minutes, RemindersJSON FROM TodosTB ORDER BY Date DESC, Time DESC'
    ).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET one todo
app.get('/todos/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM TodosTB WHERE TaskID = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create todo
app.post('/todos', (req, res) => {
  try {
    const { Task, DueDate, DueTime, Completed, Notes, CompletDateTime, ReminderMinutes, Reminder2Minutes, Reminder3Minutes, RemindersJSON } = req.body;
    const Date = DueDate ?? req.body.Date ?? null;
    const Time = DueTime ?? req.body.Time ?? null;
    const R1 = ReminderMinutes ?? 0, R2 = Reminder2Minutes ?? 0, R3 = Reminder3Minutes ?? 0;
    const RJ = RemindersJSON != null && RemindersJSON !== '' ? String(RemindersJSON) : null;
    const stmt = db.prepare(
      'INSERT INTO TodosTB (Task, "Date", "Time", Completed, Notes, CompletDateTime, ReminderMinutes, Reminder2Minutes, Reminder3Minutes, RemindersJSON) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(Task, Date, Time, Completed ?? 0, Notes ?? null, CompletDateTime ?? null, R1, R2, R3, RJ);
    res.status(201).json({ TaskID: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update todo
app.put('/todos/:id', (req, res) => {
  try {
    const { Task, DueDate, DueTime, Completed, Notes, CompletDateTime, ReminderMinutes, Reminder2Minutes, Reminder3Minutes, RemindersJSON } = req.body;
    const Date = DueDate ?? req.body.Date ?? null;
    const Time = DueTime ?? req.body.Time ?? null;
    const R1 = ReminderMinutes ?? 0, R2 = Reminder2Minutes ?? 0, R3 = Reminder3Minutes ?? 0;
    const RJ = RemindersJSON != null && RemindersJSON !== '' ? String(RemindersJSON) : null;
    const stmt = db.prepare(
      'UPDATE TodosTB SET Task = ?, "Date" = ?, "Time" = ?, Completed = ?, Notes = ?, CompletDateTime = ?, ReminderMinutes = ?, Reminder2Minutes = ?, Reminder3Minutes = ?, RemindersJSON = ? WHERE TaskID = ?'
    );
    stmt.run(Task, Date, Time, Completed ?? 0, Notes ?? null, CompletDateTime ?? null, R1, R2, R3, RJ, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE todo: trigger tr_TodosTB_after_delete records the audit row
app.delete('/todos/:id', (req, res) => {
  try {
    const id = req.params.id;
    const row = db.prepare('SELECT TaskID, Task FROM TodosTB WHERE TaskID = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM TodosTB WHERE TaskID = ?').run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH toggle completed
app.patch('/todos/:id/toggle', (req, res) => {
  try {
    const { completed } = req.body;
    const CompletDateTime = completed ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
    db.prepare('UPDATE TodosTB SET Completed = ?, CompletDateTime = ? WHERE TaskID = ?').run(
      completed ? 1 : 0,
      CompletDateTime,
      req.params.id
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check (for app to detect server)
app.get('/ping', (req, res) => {
  res.json({ ok: true, db: 'TodoDB.db' });
});

// Reset: delete all todos and audit rows (empty DB)
app.post('/reset', (req, res) => {
  try {
    db.exec('DELETE FROM TodosTB');
    db.exec('DELETE FROM AuditTB');
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('TodosTB','AuditTB')");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`TodoDB API server running at http://localhost:${PORT}`);
  console.log('Start the TodoApp (npm run dev) and it will use this server to update TodoDB.db');
});
