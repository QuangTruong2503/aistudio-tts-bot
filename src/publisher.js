const path = require('path');
const { resolveLocator } = require('./browser');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrlBase(url) {
  return String(url || '')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/+$/, '');
}

/**
 * Find an existing tab for the CMS chapters page or open a new tab in the same Chrome context.
 */
async function getOrOpenPublishPage(browser, publishUrl, logger) {
  const targetNorm = normalizeUrlBase(publishUrl);
  const contexts = browser.contexts();

  for (const context of contexts) {
    for (const p of context.pages()) {
      if (normalizeUrlBase(p.url()) === targetNorm) {
        logger.debug(`Tái sử dụng tab CMS đang mở: ${p.url()}`);
        await p.bringToFront().catch(() => {});
        return p;
      }
    }
  }

  const context = contexts[0];
  if (!context) {
    throw new Error('Không tìm thấy browser context trong Chrome CDP để mở tab CMS.');
  }

  logger.info(`Đang mở tab CMS: ${publishUrl}`);
  const page = await context.newPage();
  await page.goto(publishUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { timeout: 15000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  return page;
}

/**
 * Verify that the CMS page is authenticated (not 403 / login screen).
 */
async function ensureCmsAuthenticated(page, publishUrl) {
  const url = page.url().toLowerCase();
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');

  const isAuthBlocked =
    url.includes('/login') ||
    url.includes('/signin') ||
    bodyText.includes('403 Forbidden') ||
    bodyText.includes('Không có quyền truy cập') ||
    bodyText.includes('Vui lòng đăng nhập bằng tài khoản Quản trị viên');

  if (isAuthBlocked) {
    throw new Error(
      `Trang CMS (${publishUrl}) yêu cầu đăng nhập tài khoản Quản trị viên. ` +
        'Hãy đăng nhập 1 lần ngay trong cửa sổ Chrome Debug rồi chạy lại.'
    );
  }
}

/**
 * Extract the current chapter count from the "Danh sách chương 91" or "Danh sách chương (91)" tab button.
 */
async function readChapterCount(page, config) {
  const match = await resolveLocator(page, config.publish.selectors.chaptersListTab, {
    visibleOnly: true,
  });
  if (!match) return null;

  const text = ((await match.locator.innerText().catch(() => '')) || '').trim();
  const m = text.match(/(\d+)\s*\)?\s*$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

async function isButtonReady(locator) {
  try {
    if (!(await locator.isVisible())) return false;
    if (await locator.isDisabled()) return false;
    const ariaDisabled = await locator.getAttribute('aria-disabled');
    return ariaDisabled !== 'true';
  } catch {
    return false;
  }
}

/**
 * Set one or more local files onto <input type="file"> using direct CDP DOM.setFileInputFiles
 * so large (30MB+) WAV files attach instantly without Playwright's 30s CDP buffer transfer timeout.
 */
async function setFileInputFast(page, locator, filePaths, logger) {
  const resolvedPaths = (Array.isArray(filePaths) ? filePaths : [filePaths]).map((p) =>
    path.resolve(p)
  );
  let cdp;
  try {
    const handle = await locator.elementHandle({ timeout: 10000 });
    if (!handle) {
      throw new Error('Không lấy được elementHandle cho input[type="file"].');
    }

    cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');

    // Obtain RemoteObjectId for the <input type="file"> node via Runtime/DOM
    const remoteObject = await cdp.send('Runtime.evaluate', {
      expression:
        'document.querySelector(\'div[role="tabpanel"] input[type="file"]\') || document.querySelector(\'main input[type="file"]\') || document.querySelector(\'input[type="file"]\')',
      returnByValue: false,
    });

    const objectId = remoteObject?.result?.objectId;
    if (!objectId) {
      await handle.dispose().catch(() => {});
      throw new Error('Không tìm thấy objectId của input[type="file"] qua CDP.');
    }

    await cdp.send('DOM.setFileInputFiles', {
      files: resolvedPaths,
      objectId,
    });

    await handle.dispose().catch(() => {});
    logger.debug(`Đã gán ${resolvedPaths.length} file trực tiếp qua CDP DOM.setFileInputFiles.`);
    return;
  } catch (err) {
    logger.warn(`CDP DOM.setFileInputFiles thất bại (${err.message}), thử lại bằng locator.setInputFiles...`);
    await locator.setInputFiles(resolvedPaths, { timeout: 120000 });
  } finally {
    if (cdp) {
      await cdp.detach().catch(() => {});
    }
  }
}

/**
 * Configure Auto-Merge checkbox, merge silence gap, and AAC bitrate in the Bulk Upload tab.
 */
async function configureUploadOptions(cmsPage, config, logger) {
  const { selectors, autoMerge, mergeGap, aacBitrate } = config.publish;

  // 1. Auto-merge checkbox
  let autoMergeChecked = Boolean(autoMerge);
  if (selectors.autoMergeCheckbox) {
    const cbMatch = await resolveLocator(cmsPage, selectors.autoMergeCheckbox, {
      visibleOnly: true,
    });
    if (cbMatch) {
      const isChecked = await cbMatch.locator.isChecked().catch(() => true);
      if (isChecked !== autoMergeChecked) {
        if (autoMergeChecked) {
          await cbMatch.locator.check().catch(() => {});
        } else {
          await cbMatch.locator.uncheck().catch(() => {});
        }
        await cmsPage.waitForTimeout(200);
      }
      autoMergeChecked = await cbMatch.locator.isChecked().catch(() => autoMergeChecked);
      logger.debug(`Auto-merge phần cùng chương: ${autoMergeChecked ? 'BẬT' : 'TẮT'}`);
    }
  }

  // 2. Segment join silence dropdown (#merge-gap-select) — visible only when auto-merge is checked
  if (autoMergeChecked && mergeGap && selectors.mergeGapSelect) {
    const gapMatch = await resolveLocator(cmsPage, selectors.mergeGapSelect, { visibleOnly: true });
    if (gapMatch) {
      const curVal = await gapMatch.locator.inputValue().catch(() => '');
      if (curVal !== String(mergeGap)) {
        await gapMatch.locator.selectOption(String(mergeGap)).catch(() => {});
      }
    }
  }

  // 3. AAC bitrate dropdown (#aac-bitrate-select)
  if (aacBitrate && selectors.aacBitrateSelect) {
    const brMatch = await resolveLocator(cmsPage, selectors.aacBitrateSelect, {
      visibleOnly: true,
    });
    if (brMatch) {
      const curVal = await brMatch.locator.inputValue().catch(() => '');
      if (curVal !== String(aacBitrate)) {
        await brMatch.locator.selectOption(String(aacBitrate)).catch(() => {});
      }
    }
  }

  return { autoMergeChecked };
}

/**
 * Upload & publish one or more downloaded audio files to the CMS chapters page via "Nhập Audio / Upload".
 */
async function publishAudioToCms(
  browser,
  aiStudioPage,
  config,
  audioFilePaths,
  logger,
  shouldStop,
  options = {}
) {
  const filesList = Array.isArray(audioFilePaths) ? audioFilePaths : [audioFilePaths];
  if (filesList.length === 0) return { initialCount: null, currentCount: null };

  const publishUrl = config.publish.chaptersUrl;
  const fileNames = filesList.map((p) => path.basename(p));
  const label =
    fileNames.length === 1
      ? `"${fileNames[0]}"`
      : `${fileNames.length} file (${fileNames[0]} .. ${fileNames[fileNames.length - 1]})`;

  logger.info(`Đang đăng ${label} lên CMS: ${publishUrl}`);

  const cmsPage = await getOrOpenPublishPage(browser, publishUrl, logger);

  try {
    // Wait briefly for SPA hydration
    await cmsPage.waitForTimeout(800);
    await ensureCmsAuthenticated(cmsPage, publishUrl);

    const initialCount = await readChapterCount(cmsPage, config);
    logger.debug(`Số chương hiện tại trên CMS: ${initialCount ?? 'không xác định'}`);

    // Switch to "Nhập Audio / Upload" tab (or legacy "Tải lên hàng loạt")
    const bulkTab = await resolveLocator(cmsPage, config.publish.selectors.bulkUploadTab, {
      visibleOnly: true,
    });
    if (!bulkTab) {
      throw new Error(
        'Không tìm thấy tab "Nhập Audio / Upload" trên trang CMS. Hãy kiểm tra lại URL hoặc selector trong config.js.'
      );
    }

    await bulkTab.locator.click({ timeout: 10000 });
    await cmsPage.waitForTimeout(500);

    // Ensure Auto-Merge, merge silence gap, and AAC bitrate match config
    const { autoMergeChecked } = await configureUploadOptions(cmsPage, config, logger);

    // When auto-merge is ON for 1 chapter's parts (_1.._4), CMS merges them into 1 single chapter (+1)
    const expectedAdded =
      typeof options.expectedChaptersAdded === 'number'
        ? options.expectedChaptersAdded
        : autoMergeChecked
          ? 1
          : filesList.length;
    const expectedMinCount = initialCount !== null ? initialCount + expectedAdded : null;

    // Clear leftover queue from a previous run if button exists
    const clearBtn = await resolveLocator(cmsPage, config.publish.selectors.clearQueueButton, {
      visibleOnly: true,
    });
    if (clearBtn && (await isButtonReady(clearBtn.locator))) {
      await clearBtn.locator.click().catch(() => {});
      await cmsPage.waitForTimeout(300);
    }

    // Locate <input type="file"> (hidden inside dropzone)
    const fileInputMatch = await resolveLocator(cmsPage, config.publish.selectors.fileInput, {
      visibleOnly: false,
    });
    if (!fileInputMatch) {
      throw new Error('Không tìm thấy <input type="file"> trong tab Nhập Audio / Upload.');
    }

    logger.info(`Đang chọn ${label} vào tab Nhập Audio / Upload...`);
    await setFileInputFast(cmsPage, fileInputMatch.locator, filesList, logger);

    // Wait up to 8s for the upload/submit button (e.g. "Bắt đầu (1)") to appear and become enabled
    let submitMatch = null;
    const submitWaitDeadline = Date.now() + 8000;
    while (Date.now() < submitWaitDeadline) {
      const candidate = await resolveLocator(cmsPage, config.publish.selectors.uploadSubmitButton, {
        visibleOnly: true,
      });
      if (candidate && (await isButtonReady(candidate.locator))) {
        submitMatch = candidate;
        break;
      }
      await sleep(300);
    }

    if (submitMatch) {
      const btnText = ((await submitMatch.locator.innerText().catch(() => '')) || '').trim();
      logger.info(`Bấm nút đăng: "${btnText}" (${submitMatch.selector})`);
      await submitMatch.locator.click({ timeout: 10000 });
    } else {
      logger.info('Không thấy nút submit riêng (có thể CMS tự động tải lên sau khi chọn file), đang chờ hoàn tất...');
    }

    // Wait for client-side multi-part merge + WAV -> AAC M4A compression + R2 upload + chapter DB save.
    // Note: Because text chapters may already be pre-imported (e.g. 2466/2466), uploading audio can UPDATE
    // an existing chapter without increasing total chapter count — check BOTH chapter count AND tabpanel status!
    const startedAt = Date.now();
    const totalWaitMs = config.publish.maxWaitUploadMs * Math.max(1, expectedAdded);
    const deadline = startedAt + totalWaitMs;
    let lastLogAt = startedAt;

    while (Date.now() < deadline) {
      if (shouldStop && shouldStop()) {
        throw new Error('Người dùng đã hủy tiến trình khi đang đăng lên CMS.');
      }

      const elapsedMs = Date.now() - startedAt;

      // Signal 1: Total chapter count increased (new chapter created)
      const currentCount = await readChapterCount(cmsPage, config);
      if (expectedMinCount !== null && currentCount !== null && currentCount >= expectedMinCount) {
        const elapsedSec = (elapsedMs / 1000).toFixed(1);
        logger.success(
          `Đăng thành công ${label} lên CMS sau ${elapsedSec}s (số chương: ${initialCount} -> ${currentCount}).`
        );
        return { initialCount, currentCount };
      }

      const panelText = await cmsPage
        .evaluate(() => {
          const panel = document.querySelector('main [role="tabpanel"]') || document.querySelector('main');
          return panel ? panel.innerText : document.body.innerText;
        })
        .catch(() => '');

      const lower = panelText.toLowerCase();

      // Check for upload errors
      if (
        lower.includes('tải lên thất bại') ||
        lower.includes('lỗi tải lên') ||
        lower.includes('upload failed') ||
        lower.includes('lỗi khi tải') ||
        lower.includes('không thể tải lên')
      ) {
        throw new Error(`CMS báo lỗi trong quá trình tải lên ${label}.`);
      }

      const isStillBusy =
        lower.includes('đang ghép') ||
        lower.includes('đang nén') ||
        lower.includes('đang tải lên') ||
        lower.includes('đang tải') ||
        lower.includes('đang xử lý') ||
        lower.includes('chờ xử lý') ||
        lower.includes('merging') ||
        lower.includes('uploading') ||
        lower.includes('compressing') ||
        lower.includes('converting');

      const hasSuccessMarker =
        lower.includes('đã tải lên') ||
        lower.includes('hoàn tất') ||
        lower.includes('thành công') ||
        lower.includes('đã lưu') ||
        lower.includes('đã cập nhật') ||
        lower.includes('uploaded');

      // Check if an enabled "Bắt đầu (" button is still waiting to process items
      const pendingStartBtn = await resolveLocator(
        cmsPage,
        ['main button:has-text("Bắt đầu (")'],
        { visibleOnly: true }
      );
      const hasPendingStart = pendingStartBtn ? await isButtonReady(pendingStartBtn.locator) : false;

      // Signal 2: Completion status inside tabpanel (works even when updating an existing text chapter!)
      if (elapsedMs >= 3000 && !isStillBusy && !hasPendingStart && hasSuccessMarker) {
        const elapsedSec = (elapsedMs / 1000).toFixed(1);
        logger.success(
          `Đăng thành công ${label} lên CMS sau ${elapsedSec}s` +
            (currentCount !== null ? ` (tổng chương: ${currentCount}).` : '.')
        );
        return { initialCount, currentCount };
      }

      if (Date.now() - lastLogAt >= 10000) {
        const elapsedSec = Math.round(elapsedMs / 1000);
        logger.info(`Đang ghép, nén & tải ${label} lên CMS... (${elapsedSec}s)`);
        lastLogAt = Date.now();
      }

      await sleep(config.publish.pollIntervalMs);
    }

    throw new Error(
      `Quá thời gian chờ đăng lên CMS (${Math.round(totalWaitMs / 1000)}s) cho ${label}.`
    );
  } finally {
    // Return focus to AI Studio tab for the next TTS chapter
    if (aiStudioPage) {
      await aiStudioPage.bringToFront().catch(() => {});
    }
  }
}

module.exports = {
  publishAudioToCms,
  getOrOpenPublishPage,
};
