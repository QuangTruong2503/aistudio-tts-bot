const { chromium } = require('playwright-core');

/**
 * Connect to an already-running Chrome instance via CDP and locate the Google AI Studio tab.
 */
async function connectToAIStudio(config, logger) {
  logger.info(`Đang kết nối tới Chrome CDP tại ${config.cdpUrl} ...`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(config.cdpUrl);
  } catch (err) {
    logger.error(`Không thể kết nối Chrome CDP tại ${config.cdpUrl}.`);
    logger.info('Hãy chắc chắn bạn đã mở Chrome ở chế độ Debug bằng script:');
    logger.info('  - Windows:     scripts\\start-chrome.bat');
    logger.info('  - macOS/Linux: ./scripts/start-chrome.sh');
    throw new Error(`CDP connection failed: ${err.message}`);
  }

  const contexts = browser.contexts();
  const allPages = [];
  for (const context of contexts) {
    for (const page of context.pages()) {
      allPages.push(page);
    }
  }

  logger.debug(`Tìm thấy ${allPages.length} tab đang mở trong Chrome.`);

  // 1. Primary match: exact targetUrlPattern (aistudio.google.com/generate-speech)
  let targetPage = allPages.find((p) => p.url().includes(config.targetUrlPattern));

  // 2. Fallback match: aistudio.google.com
  if (!targetPage && config.fallbackUrlPattern) {
    targetPage = allPages.find((p) => p.url().includes(config.fallbackUrlPattern));
    if (targetPage) {
      logger.warn(
        `Không thấy tab "${config.targetUrlPattern}", đang dùng tab dự phòng: ${targetPage.url()}`
      );
    }
  }

  if (!targetPage) {
    await safeDisconnect(browser, logger);
    logger.error(`Không tìm thấy tab nào chứa "${config.targetUrlPattern}" trong Chrome.`);
    logger.info(
      'Vui lòng mở trang https://aistudio.google.com/generate-speech?model=gemini-3.8-flash-tts trong cửa sổ Chrome debug, đăng nhập Google và chạy lại.'
    );
    throw new Error('AI Studio tab not found');
  }

  logger.success(`Đã kết nối tới tab: ${targetPage.url()}`);

  try {
    await targetPage.bringToFront();
  } catch (err) {
    logger.warn(`Không thể bringToFront tab: ${err.message}`);
  }

  return {
    browser,
    page: targetPage,
    disconnect: () => safeDisconnect(browser, logger),
  };
}

/**
 * Safely disconnect from CDP without closing the user's Chrome window.
 * In playwright-core, browser.close() on a connectOverCDP() instance only drops the CDP session.
 */
async function safeDisconnect(browser, logger) {
  if (!browser) return;
  try {
    await browser.close();
    if (logger) {
      logger.info('Đã ngắt kết nối CDP (cửa sổ Chrome của bạn vẫn được giữ nguyên).');
    }
  } catch {
    // Ignore errors if already disconnected
  }
}

/**
 * Resolve the first matching locator from an ordered list of fallback selectors.
 */
async function resolveLocator(page, selectors, options = {}) {
  const { visibleOnly = true, preferLast = false } = options;

  for (const selector of selectors) {
    try {
      const group = page.locator(selector);
      const count = await group.count();
      if (count === 0) continue;

      if (!visibleOnly) {
        const chosen = preferLast ? group.last() : group.first();
        return { locator: chosen, selector, count };
      }

      const indices = preferLast
        ? Array.from({ length: count }, (_, i) => count - 1 - i)
        : Array.from({ length: count }, (_, i) => i);

      for (const idx of indices) {
        const candidate = group.nth(idx);
        const isVis = await candidate.isVisible().catch(() => false);
        if (isVis) {
          return { locator: candidate, selector, count };
        }
      }
    } catch {
      // Invalid or unsupported selector syntax on current page; try next
    }
  }

  return null;
}

/**
 * Inspect key UI elements on the open AI Studio page and highlight them in red for 3 seconds.
 */
async function inspectPage(page, config, logger) {
  logger.info('=== CHẾ ĐỘ KIỂM TRA SELECTOR (--inspect) ===');
  logger.info(`URL hiện tại: ${page.url()}`);

  const checks = [
    { key: 'promptInput', label: 'promptInput (Ô nhập văn bản)', visibleOnly: true, required: true },
    { key: 'runButton', label: 'runButton (Nút Run)', visibleOnly: true, required: true },
    { key: 'downloadButton', label: 'downloadButton (Nút Download)', visibleOnly: true, required: true },
    { key: 'stopButton', label: 'stopButton (Nút Stop/Spinner)', visibleOnly: true, required: false },
    { key: 'audioElement', label: 'audioElement (Thẻ <audio>)', visibleOnly: false, required: false },
    { key: 'durationLabel', label: 'durationLabel (Thời lượng audio)', visibleOnly: true, required: false },
  ];

  const foundHandles = [];
  let requiredMissing = 0;

  for (const item of checks) {
    const selectors = config.selectors[item.key] || [];
    const match = await resolveLocator(page, selectors, { visibleOnly: item.visibleOnly });

    if (match) {
      logger.success(`[OK]      ${item.label} -> selector: ${match.selector}`);
      if (item.visibleOnly) {
        const handle = await match.locator.elementHandle().catch(() => null);
        if (handle) {
          foundHandles.push({ key: item.key, handle });
        }
      }
    } else {
      if (item.required) {
        requiredMissing += 1;
        logger.error(`[MISSING] ${item.label} (không tìm thấy selector phù hợp)`);
      } else {
        logger.warn(`[MISSING] ${item.label} (bình thường nếu chưa có audio hoặc chưa chạy)`);
      }
    }
  }

  if (foundHandles.length > 0) {
    logger.info(`Đang highlight viền đỏ ${foundHandles.length} phần tử trên trình duyệt trong 3 giây...`);

    const savedStyles = [];
    for (const { key, handle } of foundHandles) {
      try {
        const prev = await page.evaluate(
          ({ el, tag }) => {
            const prevOutline = el.style.outline;
            const prevOutlineOffset = el.style.outlineOffset;
            const prevBoxShadow = el.style.boxShadow;
            el.style.outline = '3px solid #ff1e1e';
            el.style.outlineOffset = '2px';
            el.style.boxShadow = '0 0 12px rgba(255, 30, 30, 0.7)';

            const rect = el.getBoundingClientRect();
            const badge = document.createElement('div');
            badge.dataset.aistudioInspectBadge = 'true';
            badge.textContent = tag;
            Object.assign(badge.style, {
              position: 'fixed',
              top: `${Math.max(4, rect.top - 22)}px`,
              left: `${Math.max(4, rect.left)}px`,
              zIndex: '2147483647',
              background: '#ff1e1e',
              color: '#ffffff',
              fontSize: '12px',
              fontWeight: 'bold',
              fontFamily: 'monospace',
              padding: '2px 6px',
              borderRadius: '4px',
              pointerEvents: 'none',
            });
            document.body.appendChild(badge);

            return { prevOutline, prevOutlineOffset, prevBoxShadow };
          },
          { el: handle, tag: key }
        );
        savedStyles.push({ handle, prev });
      } catch {
        // Ignore transient DOM errors during highlight
      }
    }

    await page.waitForTimeout(3000);

    // Restore original styles and remove badges
    for (const { handle, prev } of savedStyles) {
      try {
        await page.evaluate(
          ({ el, style }) => {
            el.style.outline = style.prevOutline;
            el.style.outlineOffset = style.prevOutlineOffset;
            el.style.boxShadow = style.prevBoxShadow;
          },
          { el: handle, style: prev }
        );
      } catch {
        // Ignore
      } finally {
        await handle.dispose().catch(() => {});
      }
    }

    await page
      .evaluate(() => {
        document
          .querySelectorAll('[data-aistudio-inspect-badge="true"]')
          .forEach((node) => node.remove());
      })
      .catch(() => {});
  }

  if (requiredMissing > 0) {
    logger.warn(
      `Có ${requiredMissing} phần tử quan trọng bị MISSING. Hãy kiểm tra trang AI Studio (đảm bảo đã có ít nhất 1 audio nếu muốn thấy downloadButton) hoặc cập nhật selector trong config.js.`
    );
  } else {
    logger.success('Tất cả các phần tử chính (promptInput, runButton, downloadButton) đều OK!');
  }
}

module.exports = {
  connectToAIStudio,
  safeDisconnect,
  resolveLocator,
  inspectPage,
};
