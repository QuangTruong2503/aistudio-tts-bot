const fs = require('fs');
const path = require('path');

function ensureDirectories(dirs) {
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Scan inputDir for .txt files and sort them naturally (e.g. Chuong_2.txt before Chuong_10.txt).
 */
function getInputFiles(inputDir) {
  if (!fs.existsSync(inputDir)) {
    return [];
  }

  const entries = fs.readdirSync(inputDir, { withFileTypes: true });
  const txtFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  return txtFiles.map((fileName) => {
    const ext = path.extname(fileName);
    return {
      fileName,
      baseName: fileName.slice(0, -ext.length),
      fullPath: path.join(inputDir, fileName),
    };
  });
}

/**
 * Read UTF-8 text file. Returns null if empty after trimming.
 */
function readTextFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Strip UTF-8 BOM if present, normalize CRLF to LF
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (normalized.trim().length === 0) {
    return null;
  }
  return normalized;
}

/**
 * Check if an output audio file already exists for baseName with size > 0 bytes.
 */
function findExistingAudio(outputDir, baseName, extensions = ['.wav', '.mp3']) {
  if (!fs.existsSync(outputDir)) return null;

  for (const ext of extensions) {
    const candidate = path.join(outputDir, `${baseName}${ext}`);
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0) {
        return {
          path: candidate,
          fileName: path.basename(candidate),
          size: stat.size,
        };
      }
    }
  }
  return null;
}

function getFailedJsonPath(logsDir) {
  return path.join(logsDir, 'failed.json');
}

function loadFailedEntries(logsDir) {
  const failedPath = getFailedJsonPath(logsDir);
  if (!fs.existsSync(failedPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(failedPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFailedEntries(logsDir, entries) {
  fs.mkdirSync(logsDir, { recursive: true });
  const failedPath = getFailedJsonPath(logsDir);
  fs.writeFileSync(failedPath, JSON.stringify(entries, null, 2), 'utf8');
}

function recordFailedFile(logsDir, fileName, reason) {
  const entries = loadFailedEntries(logsDir);
  const now = new Date().toISOString();
  const idx = entries.findIndex((item) => item.fileName === fileName);
  const record = {
    fileName,
    reason: String(reason),
    failedAt: now,
    attempts: idx >= 0 ? (entries[idx].attempts || 1) + 1 : 1,
  };

  if (idx >= 0) {
    entries[idx] = record;
  } else {
    entries.push(record);
  }
  saveFailedEntries(logsDir, entries);
}

function clearFailedFile(logsDir, fileName) {
  const entries = loadFailedEntries(logsDir);
  const filtered = entries.filter((item) => item.fileName !== fileName);
  if (filtered.length !== entries.length) {
    saveFailedEntries(logsDir, filtered);
  }
}

function getPublishedJsonPath(logsDir) {
  return path.join(logsDir, 'published.json');
}

function loadPublishedEntries(logsDir) {
  const publishedPath = getPublishedJsonPath(logsDir);
  if (!fs.existsSync(publishedPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(publishedPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isFilePublished(logsDir, baseName) {
  return loadPublishedEntries(logsDir).some((item) => item.baseName === baseName);
}

function recordPublishedFile(logsDir, { baseName, audioFileName, publishUrl }) {
  const entries = loadPublishedEntries(logsDir);
  const now = new Date().toISOString();
  const idx = entries.findIndex((item) => item.baseName === baseName);
  const record = {
    baseName,
    audioFileName,
    publishUrl,
    publishedAt: now,
  };
  if (idx >= 0) {
    entries[idx] = record;
  } else {
    entries.push(record);
  }
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(getPublishedJsonPath(logsDir), JSON.stringify(entries, null, 2), 'utf8');
}

module.exports = {
  ensureDirectories,
  getInputFiles,
  readTextFile,
  findExistingAudio,
  loadFailedEntries,
  saveFailedEntries,
  recordFailedFile,
  clearFailedFile,
  loadPublishedEntries,
  isFilePublished,
  recordPublishedFile,
};
