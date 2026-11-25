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

const SENTENCE_END_RE = /[.!?…。！？]["”'»)\]]*$/;

/**
 * Split a long text into `numParts` balanced chunks, ALWAYS cutting at the end of a paragraph
 * (preferring paragraphs that end with sentence-ending punctuation like '.', '!', '?', '…' + newline)
 * so stitched audio transitions sound natural and smooth.
 */
function splitTextIntoParts(text, numParts = 4, minCharsPerSplit = 300) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return [];

  const targetParts = Math.max(1, Math.floor(numParts));
  if (targetParts === 1 || cleaned.length < minCharsPerSplit * 2) {
    return [cleaned];
  }

  // Split into non-empty paragraphs (preserving paragraph boundaries)
  const rawParagraphs = cleaned
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  let units;
  if (rawParagraphs.length >= targetParts) {
    // Enough paragraphs: NEVER cut mid-paragraph — always cut strictly at paragraph boundaries
    units = rawParagraphs.map((para) => ({
      text: para,
      endPara: true,
      isCleanEnd: SENTENCE_END_RE.test(para),
    }));
  } else {
    // Fallback only when the file has fewer paragraphs than targetParts (e.g. single wall of text)
    units = [];
    for (const para of rawParagraphs) {
      const sentences = para
        .split(/(?<=[.!?…。！？]["”'»)\]]*)\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (sentences.length > 1) {
        for (const s of sentences) {
          units.push({ text: s, endPara: false, isCleanEnd: SENTENCE_END_RE.test(s) });
        }
        units[units.length - 1].endPara = true;
      } else {
        units.push({ text: para, endPara: true, isCleanEnd: SENTENCE_END_RE.test(para) });
      }
    }
  }

  if (units.length <= 1) {
    return [cleaned];
  }

  const actualParts = Math.min(targetParts, units.length);
  const parts = [];
  let cursor = 0;

  for (let p = 0; p < actualParts; p++) {
    const remainingParts = actualParts - p;
    if (remainingParts === 1) {
      parts.push(joinUnits(units.slice(cursor)));
      break;
    }

    let remainingChars = 0;
    for (let i = cursor; i < units.length; i++) {
      remainingChars += units[i].text.length + 1;
    }
    const idealChunkLen = remainingChars / remainingParts;

    // Must leave at least (remainingParts - 1) units for subsequent parts
    const maxEnd = units.length - (remainingParts - 1);

    // Find the best paragraph cut point: strongly prefer clean sentence-ending paragraphs
    // close to idealChunkLen (avoid cutting right after ':', ',', or a heading).
    let bestEnd = cursor + 1;
    let bestScore = Infinity;
    let runningLen = 0;

    for (let end = cursor + 1; end <= maxEnd; end++) {
      runningLen += (end > cursor + 1 ? 1 : 0) + units[end - 1].text.length;
      const dist = Math.abs(runningLen - idealChunkLen);
      const endsCleanly = units[end - 1].isCleanEnd;
      // Penalize non-sentence-ending paragraph boundaries (e.g. ending with ':' or ',')
      const penalty = endsCleanly ? 0 : idealChunkLen * 0.35;
      const score = dist + penalty;

      if (score < bestScore) {
        bestScore = score;
        bestEnd = end;
      }

      // Once we're well past idealChunkLen and already have a clean cut, stop scanning
      if (runningLen > idealChunkLen * 1.45 && bestScore < idealChunkLen * 0.4) {
        break;
      }
    }

    parts.push(joinUnits(units.slice(cursor, bestEnd)));
    cursor = bestEnd;
  }

  return parts.filter((part) => part.trim().length > 0);
}

function joinUnits(slice) {
  let out = '';
  for (let i = 0; i < slice.length; i++) {
    if (i > 0) {
      out += slice[i - 1].endPara ? '\n' : ' ';
    }
    out += slice[i].text;
  }
  return out.trim();
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

function isChapterCompletedInLog(logsDir, chapterBaseName, expectedParts = 1) {
  const entries = loadPublishedEntries(logsDir);
  // Direct chapter-level or legacy single-file entry
  if (entries.some((item) => item.chapterBaseName === chapterBaseName || item.baseName === chapterBaseName)) {
    return true;
  }
  if (expectedParts > 1) {
    for (let k = 1; k <= expectedParts; k++) {
      if (!entries.some((item) => item.baseName === `${chapterBaseName}_${k}`)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function recordPublishedFile(logsDir, { baseName, chapterBaseName, audioFileName, publishUrl }) {
  const entries = loadPublishedEntries(logsDir);
  const now = new Date().toISOString();
  const idx = entries.findIndex((item) => item.baseName === baseName);
  const record = {
    baseName,
    ...(chapterBaseName ? { chapterBaseName } : {}),
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

function cleanupAudioFiles(filePaths, logger) {
  let removed = 0;
  for (const fp of filePaths) {
    try {
      if (fp && fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        removed += 1;
      }
    } catch (err) {
      if (logger) {
        logger.warn(`Không thể xóa file tạm "${path.basename(fp)}": ${err.message}`);
      }
    }
  }
  if (removed > 0 && logger) {
    logger.info(`Đã dọn dẹp ${removed} file audio trong output/ sau khi đăng CMS thành công.`);
  }
  return removed;
}

/**
 * Scan outputDir for audio files and group multi-part files (e.g. "Chương 1435 - ABC_1.wav" .. "_8.wav")
 * into chapter-level bundles sorted naturally so CMS Auto-Merge stitches each chapter cleanly in 1 upload.
 */
function groupOutputAudioByChapter(outputDir, supportedExtensions = ['.wav', '.mp3', '.ogg', '.m4a']) {
  if (!fs.existsSync(outputDir)) return [];
  const exts = new Set(supportedExtensions.map((e) => e.toLowerCase()));

  const rawFiles = fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((e) => e.isFile() && exts.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((fileName) => {
      const ext = path.extname(fileName);
      const fullPath = path.join(outputDir, fileName);
      const stat = fs.statSync(fullPath);
      const baseName = fileName.slice(0, -ext.length);
      return {
        fileName,
        baseName,
        fullPath,
        size: stat.size,
      };
    })
    .filter((f) => f.size > 0);

  const groupsMap = new Map();

  for (const file of rawFiles) {
    // Detect part suffix: "_1", "_02", " (1)", " - Part 1", " Part 1"
    const partMatch = file.baseName.match(/^(.*?)(?:_(\d+)|\s*\((\d+)\)|\s*[-–]?\s*part\s*(\d+))$/i);
    let chapterBaseName = file.baseName;
    let partNumber = null;

    if (partMatch && partMatch[1].trim().length > 0) {
      chapterBaseName = partMatch[1].trim();
      partNumber = Number.parseInt(partMatch[2] || partMatch[3] || partMatch[4], 10);
    }

    let group = groupsMap.get(chapterBaseName);
    if (!group) {
      group = {
        chapterBaseName,
        files: [],
        totalSize: 0,
      };
      groupsMap.set(chapterBaseName, group);
    }

    group.files.push({ ...file, partNumber });
    group.totalSize += file.size;
  }

  // Sort chapters naturally and sort parts inside each chapter numerically
  const groups = Array.from(groupsMap.values()).sort((a, b) =>
    a.chapterBaseName.localeCompare(b.chapterBaseName, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  );

  for (const g of groups) {
    g.files.sort((a, b) => {
      if (a.partNumber !== null && b.partNumber !== null) return a.partNumber - b.partNumber;
      return a.fileName.localeCompare(b.fileName, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });

    // Check for sequence gaps (e.g. has _1 and _3 but missing _2)
    const numbered = g.files.filter((f) => f.partNumber !== null).map((f) => f.partNumber);
    let hasGap = false;
    if (numbered.length > 0) {
      const maxPart = Math.max(...numbered);
      for (let k = 1; k <= maxPart; k++) {
        if (!numbered.includes(k)) {
          hasGap = true;
          break;
        }
      }
    }
    g.hasSequenceGap = hasGap;
    g.isMultiPart = g.files.length > 1 || numbered.length > 0;
  }

  return groups;
}

module.exports = {
  ensureDirectories,
  getInputFiles,
  readTextFile,
  splitTextIntoParts,
  findExistingAudio,
  loadFailedEntries,
  saveFailedEntries,
  recordFailedFile,
  clearFailedFile,
  loadPublishedEntries,
  isFilePublished,
  isChapterCompletedInLog,
  recordPublishedFile,
  cleanupAudioFiles,
  groupOutputAudioByChapter,
};
