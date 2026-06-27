/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           S³ BACKUP UTILITY                                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Performs timestamped file backups of the shared SQLite database
 * before schema migrations (7.4e). Supports configurable retention,
 * listing available backups, and manual restore via Discord command.
 *
 * The backup directory defaults to <cwd>/backups/ and is created
 * automatically on first use.
 *
 * ─── ASSUMPTION ──────────────────────────────────────────────────
 *
 * All S³-supported consumer plugins (SmartAssign, TeamBalancer,
 * EloTracker, Switch) are expected to use the same database
 * connector as S³ core. The MigrationEngine operates on one
 * connector/file, and this backup utility backs up that single file.
 * If a future refactor introduces per-plugin connectors, the backup
 * integration point in MigrationEngine.runMigrations() will need
 * updating accordingly.
 *
 * ─── METHODS ────────────────────────────────────────────────────
 *
 *   createBackup(dbPath, backupDir, retention)
 *     Copies the SQLite file to backups/ with a timestamped name.
 *     Validates size match, enforces retention limit.
 *     Returns { filename, sizeBytes } on success, null on failure.
 *
 *   listBackups(backupDir)
 *     Returns sorted array of { filename, timestamp, sizeBytes,
 *     sizeFormatted, age } from the backups/ directory.
 *
 *   restoreBackup(filename, dbPath, backupDir)
 *     Copies a backup file back to the original database path.
 *     Returns true on success, throws on failure.
 *
 * ─── DEPENDENCIES ───────────────────────────────────────────────
 *
 * Node fs, path — no external dependencies.
 *
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Format byte count to a human-readable string.
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a Unix-ms timestamp to YYYY-MM-DD-HHmmss.
 */
function timestampString(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Create a timestamped backup of a SQLite database file.
 *
 * @param {string}  dbPath          - Absolute or relative path to the SQLite file
 * @param {string}  [backupDir]     - Backup directory (default: './backups')
 * @param {number}  [retention=5]   - Max backup files to keep (oldest deleted)
 * @returns {{ filename: string, sizeBytes: number }|null}
 */
export function createBackup(dbPath, backupDir = null, retention = 5) {
  if (!dbPath) {
    return null;
  }

  const resolvedDir = backupDir || path.resolve(process.cwd(), 'backups');
  const resolvedDbPath = path.resolve(process.cwd(), dbPath);

  // Verify the source file exists
  let sourceStat;
  try {
    sourceStat = fs.statSync(resolvedDbPath);
  } catch {
    return null;
  }

  if (!sourceStat.isFile()) {
    return null;
  }

  // Ensure backup directory exists
  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
  } catch {
    return null;
  }

  // Generate timestamped filename
  const ts = timestampString(Date.now());
  const ext = path.extname(resolvedDbPath) || '.sqlite';
  const baseName = path.basename(resolvedDbPath, ext);
  const backupFilename = `${baseName}-${ts}${ext}`;
  const backupPath = path.join(resolvedDir, backupFilename);

  // Copy the file
  try {
    fs.copyFileSync(resolvedDbPath, backupPath);
  } catch (err) {
    return null;
  }

  // Validate: verify backup file size matches original
  let backupStat;
  try {
    backupStat = fs.statSync(backupPath);
  } catch {
    return null;
  }

  if (backupStat.size !== sourceStat.size) {
    // Backup may be corrupt — remove it
    try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
    return null;
  }

  // Enforce retention: remove oldest files if count exceeds limit
  enforceRetention(resolvedDir, retention, ext);

  return {
    filename: backupFilename,
    sizeBytes: backupStat.size
  };
}

/**
 * List available backups sorted newest-first.
 *
 * @param {string} [backupDir] - Backup directory (default: './backups')
 * @returns {Array<{ filename: string, timestamp: number, sizeBytes: number, sizeFormatted: string, age: string }>}
 */
export function listBackups(backupDir = null) {
  const resolvedDir = backupDir || path.resolve(process.cwd(), 'backups');

  let files;
  try {
    files = fs.readdirSync(resolvedDir);
  } catch {
    return [];
  }

  const backups = [];

  for (const file of files) {
    const filePath = path.join(resolvedDir, file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    // Only include files matching our naming pattern (dbname-YYYY-MM-DD-HHmmss.ext)
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    const dateMatch = base.match(/-(\d{4}-\d{2}-\d{2}-\d{6})$/);
    if (!dateMatch) continue;

    const ts = parseTimestamp(dateMatch[1]);
    if (ts === null) continue;

    const ageMs = Date.now() - stat.mtimeMs;
    const ageMinutes = Math.floor(ageMs / 60000);

    backups.push({
      filename: file,
      timestamp: ts,
      sizeBytes: stat.size,
      sizeFormatted: formatSize(stat.size),
      age: ageMinutes < 60
        ? `${ageMinutes}m`
        : `${Math.floor(ageMinutes / 60)}h ${ageMinutes % 60}m`
    });
  }

  // Sort newest first
  backups.sort((a, b) => b.timestamp - a.timestamp);

  return backups;
}

/**
 * Restore a specific backup file to the original database path.
 *
 * @param {string} filename        - Backup filename (e.g. 'squad-server-2026-06-26-193015.sqlite')
 * @param {string} dbPath          - Target database path to restore to
 * @param {string} [backupDir]     - Backup directory (default: './backups')
 * @returns {boolean}
 */
export function restoreBackup(filename, dbPath, backupDir = null) {
  if (!filename || !dbPath) {
    throw new Error('restoreBackup requires filename and dbPath.');
  }

  const resolvedDir = backupDir || path.resolve(process.cwd(), 'backups');
  const backupPath = path.join(resolvedDir, filename);
  const resolvedDbPath = path.resolve(process.cwd(), dbPath);

  // Verify the backup file exists
  let backupStat;
  try {
    backupStat = fs.statSync(backupPath);
  } catch {
    throw new Error(`Backup file not found: ${filename}`);
  }

  if (!backupStat.isFile()) {
    throw new Error(`Backup path is not a file: ${filename}`);
  }

  // Copy backup to original location (overwrite)
  try {
    fs.copyFileSync(backupPath, resolvedDbPath);
  } catch (err) {
    throw new Error(`Failed to restore backup: ${err.message}`);
  }

  // Validate restored file
  let restoredStat;
  try {
    restoredStat = fs.statSync(resolvedDbPath);
  } catch {
    throw new Error('Restored database file is not accessible after copy.');
  }

  if (restoredStat.size !== backupStat.size) {
    throw new Error('Restored file size does not match backup — possible corruption.');
  }

  return true;
}

/* ────────────────────────────────────── INTERNAL ────────────────────────────────────── */

/**
 * Parse a YYYY-MM-DD-HHmmss timestamp string to Unix ms.
 */
function parseTimestamp(str) {
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, min, sec] = match.map(Number);
  const d = new Date(year, month - 1, day, hour, min, sec);
  return d.getTime();
}

/**
 * Enforce retention limit — delete oldest backup files if count exceeds max.
 * Only removes files matching our naming pattern.
 */
function enforceRetention(dir, maxCount, ext) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }

  // Collect matching backup files with their modification times
  const backups = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const base = path.basename(file, ext);
    const dateMatch = base.match(/-(\d{4}-\d{2}-\d{2}-\d{6})$/);
    if (!dateMatch) continue;

    backups.push({ filename: file, mtimeMs: stat.mtimeMs });
  }

  if (backups.length <= maxCount) return;

  // Sort oldest first
  backups.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const toDelete = backups.slice(0, backups.length - maxCount);

  for (const b of toDelete) {
    try {
      fs.unlinkSync(path.join(dir, b.filename));
    } catch {
      /* best-effort cleanup */
    }
  }
}