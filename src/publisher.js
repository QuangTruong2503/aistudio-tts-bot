const path = require('path');
const { resolveLocator } = require('./browser');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Find an existing tab for the CMS chapters page or open a new tab in the same Chrome context.
 */
async function getOrOpenPublishPage(browser, publishUrl, logger) {
  const targetNorm = normalizeUrl(publishUrl);
  const contexts = browser.contexts();

  for (const context of contexts) {
    for (const p of context.pages()) {
      if (normalizeUrl(p.url()).startsWith(targetNorm)) {
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
 * Extract the current chapter count from the "Danh sách chương (N)" tab button.
 */
async function readChapterCount(page, config) {
  const match = await resolveLocator(page, config.publish.selectors.chaptersListTab, {
    visibleOnly: true,
  });
  if (!match) return null;

  const text = ((await match.locator.innerText().catch(() => '')) || '').trim();
  const m = text.match(/\((\d+)\)/);
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
 * Set a local file onto <input type="file"> using direct CDP DOM.setFileInputFiles
 * so large (30MB+) WAV files attach instantly without Playwright's 30s CDP buffer transfer timeout.
 */
async function setFileInputFast(page, locator, filePath, logger) {
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
      expression: 'document.querySelector(\'main input[type="file"]\') || document.querySelector(\'input[type="file"]\')',
      returnByValue: false,
    });

    const objectId = remoteObject?.result?.objectId;
    if (!objectId) {
      await handle.dispose().catch(() => {});
      throw new Error('Không tìm thấy objectId của input[type="file"] qua CDP.');
    }

    await cdp.send('DOM.setFileInputFiles', {
      files: [path.resolve(filePath)],
      objectId,
    });

    await handle.dispose().catch(() => {});
    logger.debug('Đã gán file trực tiếp qua CDP DOM.setFileInputFiles.');
    return;
  } catch (err) {
    logger.warn(`CDP DOM.setFileInputFiles thất bại (${err.message}), thử lại bằng locator.setInputFiles...`);
    await locator.setInputFiles(filePath, { timeout: 120000 });
  } finally {
    if (cdp) {
      await cdp.detach().catch(() => {});
    }
  }
}

/**
 * Upload & publish a downloaded audio file to the CMS chapters page via Bulk Upload tab.
 */
async function publishAudioToCms(browser, aiStudioPage, config, audioFilePath, logger, shouldStop) {
  const publishUrl = config.publish.chaptersUrl;
  const audioFileName = path.basename(audioFilePath);

  logger.info(`Đang đăng "${audioFileName}" lên CMS: ${publishUrl}`);

  const cmsPage = await getOrOpenPublishPage(browser, publishUrl, logger);

  try {
    // Wait briefly for SPA hydration
    await cmsPage.waitForTimeout(800);
    await ensureCmsAuthenticated(cmsPage, publishUrl);

    const initialCount = await readChapterCount(cmsPage, config);
    logger.debug(`Số chương hiện tại trên CMS: ${initialCount ?? 'không xác định'}`);

    // Switch to "Tải lên hàng loạt (Bulk Upload)" tab
    const bulkTab = await resolveLocator(cmsPage, config.publish.selectors.bulkUploadTab, {
      visibleOnly: true,
    });
    if (!bulkTab) {
      throw new Error(
        'Không tìm thấy tab "Tải lên hàng loạt (Bulk Upload)" trên trang CMS. Hãy kiểm tra lại URL hoặc selector trong config.js.'
      );
    }

    await bulkTab.locator.click({ timeout: 10000 });
    await cmsPage.waitForTimeout(500);

    // Clear leftover queue from a previous run if button exists
    const clearBtn = await resolveLocator(cmsPage, config.publish.selectors.clearQueueButton, {
      visibleOnly: true,
    });
    if (clearBtn && (await isButtonReady(clearBtn.locator))) {
      await clearBtn.locator.click().catch(() => {});
      await cmsPage.waitForTimeout(300);
    }

    // Locate <input type="file"> (may be hidden inside dropzone)
    const fileInputMatch = await resolveLocator(cmsPage, config.publish.selectors.fileInput, {
      visibleOnly: false,
    });
    if (!fileInputMatch) {
      throw new Error('Không tìm thấy <input type="file"> trong tab Tải lên hàng loạt.');
    }

    logger.info(`Đang chọn file "${audioFileName}" vào Bulk Upload...`);
    await setFileInputFast(cmsPage, fileInputMatch.locator, audioFilePath, logger);

    // Wait up to 5s for the upload/submit button to appear and become enabled (WAV metadata parsing)
    let submitMatch = null;
    const submitWaitDeadline = Date.now() + 5000;
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

    // Wait for WAV -> AAC M4A compression + R2 upload + chapter DB save
    const startedAt = Date.now();
    const deadline = startedAt + config.publish.maxWaitUploadMs;
    let lastLogAt = startedAt;

    while (Date.now() < deadline) {
      if (shouldStop && shouldStop()) {
        throw new Error('Người dùng đã hủy tiến trình khi đang đăng lên CMS.');
      }

      const currentCount = await readChapterCount(cmsPage, config);
      if (initialCount !== null && currentCount !== null && currentCount > initialCount) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        logger.success(
          `Đăng thành công "${audioFileName}" lên CMS sau ${elapsedSec}s (số chương: ${initialCount} -> ${currentCount}).`
        );
        return { initialCount, currentCount };
      }

      const mainText = await cmsPage
        .evaluate(() => {
          const m = document.querySelector('main');
          return m ? m.innerText : document.body.innerText;
        })
        .catch(() => '');

      const lower = mainText.toLowerCase();

      // Check for upload errors
      if (
        lower.includes('tải lên thất bại') ||
        lower.includes('lỗi tải lên') ||
        lower.includes('upload failed') ||
        lower.includes('lỗi khi tải') ||
        lower.includes('không thể tải lên')
      ) {
        throw new Error(`CMS báo lỗi trong quá trình tải lên "${audioFileName}".`);
      }

      const isStillBusy =
        lower.includes('đang nén') ||
        lower.includes('đang tải lên') ||
        lower.includes('đang xử lý') ||
        lower.includes('uploading') ||
        lower.includes('compressing') ||
        lower.includes('converting');

      const hasSuccessMarker =
        lower.includes('đã tải lên') ||
        lower.includes('hoàn tất') ||
        lower.includes('thành công') ||
        lower.includes('uploaded');

      if (!isStillBusy && hasSuccessMarker) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        logger.success(`Đăng thành công "${audioFileName}" lên CMS sau ${elapsedSec}s.`);
        return { initialCount, currentCount };
      }

      if (Date.now() - lastLogAt >= 10000) {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        logger.info(`Đang nén & tải "${audioFileName}" lên CMS... (${elapsedSec}s)`);
        lastLogAt = Date.now();
      }

      await sleep(config.publish.pollIntervalMs);
    }

    throw new Error(
      `Quá thời gian chờ đăng lên CMS (${Math.round(config.publish.maxWaitUploadMs / 1000)}s) cho "${audioFileName}".`
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
