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

/**
 * Dismiss any open sidebar overlay that might block clicks on the speech editor.
 */
async function dismissOverlaysIfPresent(page) {
  const overlay = page.locator('div.sidebar-overlay').first();
  if (await overlay.isVisible().catch(() => false)) {
    await overlay.click({ force: true }).catch(() => {});
    await page.waitForTimeout(250);
  }
}

/**
 * Ensure the Speech Editor (promptInput) is mounted and ready.
 * If AI Studio is showing the Zero-State screen (ms-speech-zero-state), automatically
 * clicks "Create new dialog" to enter the editor.
 */
async function ensureSpeechEditorReady(page, config, logger, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let clickedCreateDialog = false;

  while (Date.now() < deadline) {
    // 1. Check if promptInput is already visible
    const promptMatch = await resolveLocator(page, config.selectors.promptInput, {
      visibleOnly: true,
    });
    if (promptMatch) {
      await dismissOverlaysIfPresent(page);
      return promptMatch;
    }

    // 2. Check if Zero-State screen (ms-speech-zero-state) is shown -> click "Create new dialog"
    if (!clickedCreateDialog) {
      const zeroState = await resolveLocator(
        page,
        config.selectors.zeroStateContainer || ['ms-speech-zero-state'],
        { visibleOnly: true }
      );
      if (zeroState) {
        const createCard = await resolveLocator(
          page,
          config.selectors.createNewDialogCard || [
            '[actioncardtestid="create-new-dialog-card"]',
            'ms-speech-zero-state :has-text("Create new dialog")',
          ],
          { visibleOnly: true }
        );
        if (createCard) {
          logger.info(
            `Phát hiện màn hình Zero-State -> tự động bấm "Create new dialog" (${createCard.selector})...`
          );
          await createCard.locator.click({ timeout: 5000 }).catch(() => {});
          clickedCreateDialog = true;
          await page.waitForTimeout(600);
          continue;
        }
      }
    }

    await page.waitForTimeout(400);
  }

  return null;
}

/**
 * Read the currently active TTS model name from the DOM (span[data-test-id="model-name"])
 * or fallback to the page URL (?model=...).
 */
async function getCurrentModel(page, config) {
  try {
    const labelMatch = await resolveLocator(
      page,
      config.selectors.modelNameLabel || ['span[data-test-id="model-name"]'],
      { visibleOnly: false }
    );
    if (labelMatch) {
      const txt = ((await labelMatch.locator.innerText().catch(() => '')) || '').trim();
      if (txt && txt.includes('tts')) {
        return txt;
      }
    }
  } catch {
    // Ignore DOM read error
  }

  try {
    const u = new URL(page.url());
    const fromUrl = u.searchParams.get('model');
    if (fromUrl) return fromUrl;
  } catch {
    // Ignore URL parse error
  }
  return (config.ttsModels && config.ttsModels[0]) || 'gemini-3.8-flash-tts';
}

/**
 * Try switching TTS model in-place via the right-sidebar Model Selector modal
 * (avoids full page reload and minimizes Zero-State resets).
 */
async function trySwitchModelInPlace(page, targetModel, config, logger) {
  // 1. Ensure model selector card is visible (expand right sidebar if collapsed)
  let cardMatch = await resolveLocator(
    page,
    config.selectors.modelSelectorCard || ['ms-model-selector button.model-selector-card'],
    { visibleOnly: true }
  );

  if (!cardMatch) {
    const toggleMatch = await resolveLocator(
      page,
      config.selectors.runSettingsToggle || ['button[aria-label="Toggle run settings panel"]'],
      { visibleOnly: true }
    );
    if (toggleMatch) {
      await toggleMatch.locator.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
      cardMatch = await resolveLocator(
        page,
        config.selectors.modelSelectorCard || ['ms-model-selector button.model-selector-card'],
        { visibleOnly: true }
      );
    }
  }

  if (!cardMatch) return false;

  // 2. Open Model Selection sliding drawer
  await cardMatch.locator.click({ timeout: 5000 });
  await page.waitForTimeout(500);

  // 3. Locate the target model row inside ms-model-carousel
  const rowSelectors = [
    `ms-model-carousel-row[id="model-carousel-row-models/${targetModel}"] button.content-button`,
    `ms-model-carousel-row:has-text("${targetModel}") button.content-button`,
    `mat-dialog-container button.content-button:has-text("${targetModel}")`,
  ];

  const rowMatch = await resolveLocator(page, rowSelectors, { visibleOnly: true });
  if (!rowMatch) {
    // Close modal cleanly before falling back to URL navigation
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
    await dismissOverlaysIfPresent(page);
    return false;
  }

  logger.debug(`Đổi model trực tiếp qua Model Selector: ${rowMatch.selector}`);
  await rowMatch.locator.click({ timeout: 5000 });
  await page.waitForTimeout(600);
  await dismissOverlaysIfPresent(page);
  return true;
}

/**
 * Switch the open Google AI Studio Speech Generation tab to a different TTS model.
 * Strategy 1: In-place Model Selector modal; Strategy 2: URL navigation (?model=...).
 * Always auto-dismisses the Zero-State screen ("Create new dialog") if it appears.
 */
async function switchTtsModel(page, targetModel, config, logger) {
  logger.warn(`Đang chuyển đổi sang model TTS: ${targetModel} ...`);
  await page.bringToFront().catch(() => {});

  // Strategy 1: In-place Model Selector (no full page reload)
  let switchedInPlace = false;
  try {
    switchedInPlace = await trySwitchModelInPlace(page, targetModel, config, logger);
  } catch (err) {
    logger.debug(`Đổi model qua UI modal không thành công (${err.message}), chuyển sang URL...`);
  }

  // Strategy 2: Fallback to URL navigation if in-place failed
  if (!switchedInPlace) {
    let nextUrl;
    try {
      const u = new URL(page.url());
      if (!u.pathname.includes('generate-speech')) {
        u.pathname = '/generate-speech';
      }
      u.searchParams.set('model', targetModel);
      nextUrl = u.toString();
    } catch {
      nextUrl = `https://aistudio.google.com/generate-speech?model=${encodeURIComponent(targetModel)}`;
    }

    await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  // Wait for editor (and automatically click "Create new dialog" if Zero-State appeared!)
  const ready = await ensureSpeechEditorReady(page, config, logger, 15000);
  if (!ready) {
    throw new Error(
      `Chuyển sang model ${targetModel} nhưng không thấy ô nhập văn bản sau 15s (kể cả sau khi kiểm tra Zero-State).`
    );
  }

  await page.waitForTimeout(600);
  logger.success(`Đã chuyển sang model TTS: ${targetModel}`);
  return true;
}

module.exports = {
  connectToAIStudio,
  safeDisconnect,
  resolveLocator,
  inspectPage,
  ensureSpeechEditorReady,
  getCurrentModel,
  switchTtsModel,
};
