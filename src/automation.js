const fs = require('fs');
const path = require('path');
const { resolveLocator } = require('./browser');

class GenerationError extends Error {
  constructor(message, { isQuota = false, isAccountVerify = false } = {}) {
    super(message);
    this.name = isAccountVerify ? 'AccountVerifyError' : isQuota ? 'QuotaError' : 'GenerationError';
    this.isQuota = isQuota;
    this.isAccountVerify = isAccountVerify;
  }
}

const IS_MAC = process.platform === 'darwin';
const SELECT_ALL_SHORTCUT = IS_MAC ? 'Meta+A' : 'Control+A';
const RUN_SHORTCUT = IS_MAC ? 'Meta+Enter' : 'Control+Enter';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extensionFromMime(mimeType) {
  if (!mimeType) return '.wav';
  const lower = mimeType.toLowerCase();
  if (lower.includes('mpeg') || lower.includes('mp3')) return '.mp3';
  if (lower.includes('ogg')) return '.ogg';
  if (lower.includes('mp4') || lower.includes('m4a')) return '.m4a';
  if (lower.includes('wav') || lower.includes('wave') || lower.includes('l16') || lower.includes('pcm')) {
    return '.wav';
  }
  return '.wav';
}

async function isLocatorEnabled(locator) {
  try {
    const disabled = await locator.isDisabled();
    if (disabled) return false;
    const ariaDisabled = await locator.getAttribute('aria-disabled');
    if (ariaDisabled === 'true') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Step 1: Capture current audio state on the page before triggering a new generation.
 */
async function takePreRunSnapshot(page, config) {
  const audioSrcs = await page
    .evaluate(() => {
      return Array.from(document.querySelectorAll('audio'))
        .map((a) => a.currentSrc || a.src || '')
        .filter(Boolean);
    })
    .catch(() => []);

  let durationText = '';
  const durationMatch = await resolveLocator(page, config.selectors.durationLabel, { visibleOnly: true });
  if (durationMatch) {
    durationText = ((await durationMatch.locator.innerText().catch(() => '')) || '').trim();
  } else {
    // Fallback: look for time pattern like "0:00 / 9:34" in bottom bar
    durationText = await page
      .evaluate(() => {
        const matches = document.body.innerText.match(/\b\d+:\d{2}\s*\/\s*\d+:\d{2}\b/);
        return matches ? matches[0].trim() : '';
      })
      .catch(() => '');
  }

  const downloadMatch = await resolveLocator(page, config.selectors.downloadButton, { visibleOnly: true });
  const downloadReady = downloadMatch ? await isLocatorEnabled(downloadMatch.locator) : false;

  return {
    audioSrcs,
    audioCount: audioSrcs.length,
    durationText,
    downloadReady,
    timestamp: Date.now(),
  };
}

/**
 * Step 2: Fill text into the Speech Block input without triggering '<' tag autocomplete.
 */
async function fillSpeechBlock(page, config, text, logger) {
  const match = await resolveLocator(page, config.selectors.promptInput, { visibleOnly: true });
  if (!match) {
    throw new GenerationError(
      'Không tìm thấy ô nhập văn bản (promptInput). Hãy chạy --inspect để kiểm tra selector trong config.js.'
    );
  }

  const input = match.locator;
  logger.debug(`Đang điền văn bản (${text.length} ký tự) bằng selector: ${match.selector}`);

  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ timeout: 10000 });
  await page.waitForTimeout(150);

  // Clear existing content cleanly
  await page.keyboard.press(SELECT_ALL_SHORTCUT);
  await page.waitForTimeout(80);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);

  const tagInfo = await input.evaluate((el) => ({
    tagName: el.tagName.toUpperCase(),
    isContentEditable: Boolean(el.isContentEditable),
  }));

  if (tagInfo.tagName === 'TEXTAREA' || tagInfo.tagName === 'INPUT') {
    // fill() sets value atomically and fires input/change without per-character '<' popup
    await input.fill(text);
    // Ensure Angular change detection catches the update
    await input.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  } else if (tagInfo.isContentEditable) {
    // Clear any lingering rich text nodes
    await input.evaluate((el) => {
      el.textContent = '';
    });
    await input.click();
    // insertText inserts the entire string without firing per-character keydown for '<'
    await page.keyboard.insertText(text);
    await input.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  } else {
    await input.fill(text);
  }

  // Dismiss any stray autocomplete menu just in case
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);

  // Verify text is actually present in the input
  const currentLength = await input
    .evaluate((el) => {
      if ('value' in el && typeof el.value === 'string') return el.value.trim().length;
      return (el.innerText || el.textContent || '').trim().length;
    })
    .catch(() => 0);

  if (currentLength === 0) {
    throw new GenerationError('Điền văn bản vào ô Speech Block không thành công (nội dung vẫn rỗng).');
  }

  // Wait briefly for Angular to enable the Run button
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const runMatch = await resolveLocator(page, config.selectors.runButton, { visibleOnly: true });
    if (runMatch && (await isLocatorEnabled(runMatch.locator))) {
      return;
    }
    await sleep(250);
  }
}

/**
 * Detect visible error toasts / snackbars on the page.
 */
async function detectUiError(page, config) {
  for (const selector of config.selectors.errorToast) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const text = ((await el.innerText().catch(() => '')) || '').trim();
        if (!text) continue;

        const lower = text.toLowerCase();
        const isAccountVerify = (config.accountVerifyKeywords || []).some((kw) => lower.includes(kw));
        const isQuota = !isAccountVerify && config.rateLimitKeywords.some((kw) => lower.includes(kw));
        const isError =
          isAccountVerify || isQuota || config.errorKeywords.some((kw) => lower.includes(kw));
        if (isError) {
          return { text, isQuota, isAccountVerify };
        }
      }
    } catch {
      // Ignore selector error
    }
  }
  return null;
}

/**
 * Step 3: Trigger audio generation via Run button (or Ctrl/Cmd+Enter fallback) and confirm start.
 */
async function triggerRun(page, config, snapshot, logger) {
  const runMatch = await resolveLocator(page, config.selectors.runButton, { visibleOnly: true });

  if (runMatch && (await isLocatorEnabled(runMatch.locator))) {
    logger.debug(`Click nút Run (${runMatch.selector})`);
    await runMatch.locator.click({ timeout: 10000 });
  } else {
    logger.warn('Nút Run chưa sẵn sàng để click, thử gửi phím tắt Ctrl/Cmd+Enter...');
    await page.keyboard.press(RUN_SHORTCUT);
  }

  // Confirm generation actually started (or completed very fast)
  const startDeadline = Date.now() + config.runStartTimeoutMs;
  while (Date.now() < startDeadline) {
    const uiErr = await detectUiError(page, config);
    if (uiErr) {
      throw new GenerationError(`UI báo lỗi ngay sau khi bấm Run: ${uiErr.text}`, {
        isQuota: uiErr.isQuota,
        isAccountVerify: uiErr.isAccountVerify,
      });
    }

    const stopMatch = await resolveLocator(page, config.selectors.stopButton, { visibleOnly: true });
    if (stopMatch) {
      return { sawGenerating: true };
    }

    const curRun = await resolveLocator(page, config.selectors.runButton, { visibleOnly: true });
    if (curRun && !(await isLocatorEnabled(curRun.locator))) {
      return { sawGenerating: true };
    }

    // Check if audio already updated (for very short inputs)
    const curSnap = await takePreRunSnapshot(page, config);
    const srcChanged = curSnap.audioSrcs.some((src) => !snapshot.audioSrcs.includes(src));
    const durChanged = curSnap.durationText && curSnap.durationText !== snapshot.durationText;
    if (srcChanged || durChanged) {
      return { sawGenerating: true };
    }

    await sleep(400);
  }

  logger.warn('Không thấy trạng thái loading rõ ràng sau khi bấm Run, vẫn tiếp tục theo dõi hoàn tất...');
  return { sawGenerating: false };
}

/**
 * Step 4: Poll until audio generation completes or errors/times out.
 */
async function waitForCompletion(page, config, snapshot, startState, netCapture, logger, shouldStop) {
  const startedAt = Date.now();
  const deadline = startedAt + config.maxWaitAudioMs;
  let sawGenerating = startState.sawGenerating;
  let lastProgressLog = startedAt;

  while (Date.now() < deadline) {
    if (shouldStop && shouldStop()) {
      throw new GenerationError('Người dùng đã hủy tiến trình (SIGINT).');
    }

    // 1. Check UI errors early
    const uiErr = await detectUiError(page, config);
    if (uiErr) {
      throw new GenerationError(`AI Studio báo lỗi: ${uiErr.text}`, {
        isQuota: uiErr.isQuota,
        isAccountVerify: uiErr.isAccountVerify,
      });
    }

    // 2. Check generating / loading indicators
    const stopMatch = await resolveLocator(page, config.selectors.stopButton, { visibleOnly: true });
    const runMatch = await resolveLocator(page, config.selectors.runButton, { visibleOnly: true });
    const runEnabled = runMatch ? await isLocatorEnabled(runMatch.locator) : false;
    const isGenerating = Boolean(stopMatch) || !runEnabled;

    if (isGenerating) {
      sawGenerating = true;
    }

    // 3. Check new audio indicators
    const curSnap = await takePreRunSnapshot(page, config);
    const hasNewAudioSrc = curSnap.audioSrcs.some((src) => !snapshot.audioSrcs.includes(src));
    const hasNewDuration =
      Boolean(curSnap.durationText) &&
      curSnap.durationText !== snapshot.durationText &&
      !/^0:00\s*\/\s*0:00$/.test(curSnap.durationText);
    const hasNetworkAudio = Boolean(netCapture && netCapture.buffer && netCapture.buffer.length > 0);
    const downloadNowReady = curSnap.downloadReady;

    const hasNewAudioSignal =
      hasNewAudioSrc ||
      hasNewDuration ||
      hasNetworkAudio ||
      (sawGenerating && downloadNowReady) ||
      (!snapshot.downloadReady && downloadNowReady);

    if (!isGenerating && runEnabled && hasNewAudioSignal) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      logger.info(
        `Render hoàn tất sau ${elapsedSec}s` +
          (curSnap.durationText ? ` (thời lượng: ${curSnap.durationText})` : '')
      );
      return curSnap;
    }

    // Log periodic heartbeat every 15s during long renders
    if (Date.now() - lastProgressLog >= 15000) {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      logger.info(`Đang chờ render audio... (${elapsedSec}s đã trôi qua)`);
      lastProgressLog = Date.now();
    }

    await sleep(config.pollIntervalMs);
  }

  throw new GenerationError(
    `Quá thời gian chờ render audio (${Math.round(config.maxWaitAudioMs / 1000)}s).`
  );
}

/**
 * Strategy 1: Trigger native browser download via Download button + waitForEvent('download').
 */
async function tryUiDownload(page, config, baseName, outputDir, logger) {
  const downloadMatch = await resolveLocator(page, config.selectors.downloadButton, { visibleOnly: true });
  if (!downloadMatch || !(await isLocatorEnabled(downloadMatch.locator))) {
    return null;
  }

  try {
    logger.debug(`Thử tải bằng nút Download (${downloadMatch.selector})`);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: config.downloadTimeoutMs }),
      downloadMatch.locator.click({ timeout: 10000 }),
    ]);

    const suggested = download.suggestedFilename() || `${baseName}.wav`;
    const ext = path.extname(suggested).toLowerCase() || '.wav';
    const destPath = path.join(outputDir, `${baseName}${ext}`);

    await download.saveAs(destPath);
    return destPath;
  } catch (err) {
    logger.warn(`Chiến lược 1 (UI Download) thất bại: ${err.message}`);
    return null;
  }
}

/**
 * Strategy 2: Fetch <audio> src inside page context and transfer via chunked base64.
 */
async function tryDomAudioFetch(page, baseName, outputDir, logger) {
  try {
    const result = await page.evaluate(async () => {
      const audios = Array.from(document.querySelectorAll('audio'));
      const target = audios.reverse().find((a) => a.currentSrc || a.src);
      if (!target) return null;

      const src = target.currentSrc || target.src;
      const response = await fetch(src);
      if (!response.ok) return null;

      const mimeType = response.headers.get('content-type') || '';
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // Chunked conversion avoids Maximum call stack size exceeded on large (>10MB) audio files
      const CHUNK_SIZE = 0x8000;
      const chunks = [];
      for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const slice = bytes.subarray(i, i + CHUNK_SIZE);
        chunks.push(String.fromCharCode.apply(null, slice));
      }
      const base64 = btoa(chunks.join(''));
      return { base64, mimeType, byteLength: bytes.length };
    });

    if (!result || !result.base64) {
      return null;
    }

    const ext = extensionFromMime(result.mimeType);
    const destPath = path.join(outputDir, `${baseName}${ext}`);
    fs.writeFileSync(destPath, Buffer.from(result.base64, 'base64'));
    logger.info(`Đã tải audio qua chiến lược dự phòng 1 (DOM <audio>, ${result.byteLength} bytes).`);
    return destPath;
  } catch (err) {
    logger.warn(`Chiến lược 2 (DOM <audio>) thất bại: ${err.message}`);
    return null;
  }
}

/**
 * Strategy 3: Save audio buffer captured via network response listener (optional).
 */
function tryNetworkCaptureSave(netCapture, baseName, outputDir, logger) {
  if (!netCapture || !netCapture.buffer || netCapture.buffer.length === 0) {
    return null;
  }

  const ext = extensionFromMime(netCapture.mimeType);
  const destPath = path.join(outputDir, `${baseName}${ext}`);
  fs.writeFileSync(destPath, netCapture.buffer);
  logger.info(
    `Đã lưu audio qua chiến lược dự phòng 2 (Network Intercept, ${netCapture.buffer.length} bytes).`
  );
  return destPath;
}

/**
 * Attach optional network audio interceptor for the duration of a single file.
 */
function attachNetworkInterceptor(page, enabled, logger) {
  const capture = { buffer: null, mimeType: '' };
  if (!enabled) {
    return { capture, detach: () => {} };
  }

  const handler = async (response) => {
    try {
      const contentType = (response.headers()['content-type'] || '').toLowerCase();
      if (
        contentType.includes('audio/wav') ||
        contentType.includes('audio/mpeg') ||
        contentType.includes('audio/l16') ||
        contentType.includes('audio/ogg') ||
        contentType.includes('audio/mp4')
      ) {
        const buf = await response.body();
        if (buf && buf.length > 1024) {
          capture.buffer = buf;
          capture.mimeType = contentType;
          logger.debug(`Network Intercept bắt được audio (${contentType}, ${buf.length} bytes)`);
        }
      }
    } catch {
      // Ignore streaming/closed response errors
    }
  };

  page.on('response', handler);
  return {
    capture,
    detach: () => page.off('response', handler),
  };
}

/**
 * Verify saved audio file exists and meets minimum size threshold (> 1KB).
 */
function verifySavedAudio(filePath, minSizeBytes) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new GenerationError('Không thể lưu file audio bằng bất kỳ chiến lược nào.');
  }
  const stat = fs.statSync(filePath);
  if (stat.size < minSizeBytes) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore cleanup error
    }
    throw new GenerationError(
      `File audio tải về quá nhỏ (${stat.size} bytes < ${minSizeBytes} bytes), đã xóa để tránh file hỏng.`
    );
  }
  return stat.size;
}

/**
 * Execute the full 5-step TTS generation pipeline for a single input text file.
 */
async function processSingleFile(page, config, { baseName, text, outputDir }, logger, shouldStop) {
  const { capture: netCapture, detach } = attachNetworkInterceptor(
    page,
    config.enableNetworkIntercept,
    logger
  );

  try {
    // 1. Pre-run snapshot
    const snapshot = await takePreRunSnapshot(page, config);
    logger.debug(
      `Pre-run snapshot: audioCount=${snapshot.audioCount}, duration="${snapshot.durationText}", downloadReady=${snapshot.downloadReady}`
    );

    // 2. Fill Speech Block
    await fillSpeechBlock(page, config, text, logger);

    // 3. Trigger Run
    const startState = await triggerRun(page, config, snapshot, logger);

    // 4. Wait for Completion
    await waitForCompletion(page, config, snapshot, startState, netCapture, logger, shouldStop);

    // Small settle delay for audio blob / download button binding
    await page.waitForTimeout(500);

    // 5. Multi-strategy Download
    let savedPath = await tryUiDownload(page, config, baseName, outputDir, logger);
    if (!savedPath) {
      savedPath = await tryDomAudioFetch(page, baseName, outputDir, logger);
    }
    if (!savedPath) {
      savedPath = tryNetworkCaptureSave(netCapture, baseName, outputDir, logger);
    }

    const sizeBytes = verifySavedAudio(savedPath, config.minAudioSizeBytes);
    return { savedPath, sizeBytes };
  } finally {
    detach();
  }
}

module.exports = {
  GenerationError,
  processSingleFile,
  takePreRunSnapshot,
  fillSpeechBlock,
  detectUiError,
};
