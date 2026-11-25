const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
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
 * Remove any extra speech blocks beyond the first one so the editor always has strictly 1 speaker.
 * Uses a real mouse pointer click on the delete button's bounding box because Angular's block focus
 * activation can intercept synthetic locator.click() calls on inactive blocks.
 */
async function ensureSingleSpeechBlock(page, logger) {
  try {
    const blocks = page.locator('ms-speech-block');
    let count = await blocks.count();
    if (count <= 1) return;

    logger.warn(`Phát hiện ${count} khối Speaker trên trang -> tự động xóa bớt về 1 Speaker duy nhất...`);

    let guard = 0;
    while (count > 1 && guard < 15) {
      guard += 1;
      const lastBlock = blocks.nth(count - 1);
      await lastBlock.scrollIntoViewIfNeeded().catch(() => {});
      await lastBlock.hover().catch(() => {});
      await page.waitForTimeout(150);

      const delBtn = lastBlock.locator('button[aria-label="Delete speech block"]').first();
      if (!(await delBtn.isVisible().catch(() => false))) {
        // Click block once to reveal its toolbar if needed
        await lastBlock.click({ position: { x: 20, y: 20 } }).catch(() => {});
        await page.waitForTimeout(150);
      }

      const box = await delBtn.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await delBtn.click({ force: true }).catch(() => {});
      }

      await page.waitForTimeout(300);
      const nextCount = await blocks.count();
      if (nextCount >= count) {
        // Fallback: retry pointer click once more in case first click only focused the block
        const box2 = await delBtn.boundingBox().catch(() => null);
        if (box2) {
          await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
          await page.waitForTimeout(300);
        }
      }
      count = await blocks.count();
    }

    if (count === 1) {
      logger.success('Đã dọn sạch về đúng 1 Speaker duy nhất.');
    } else {
      logger.warn(`Vẫn còn ${count} khối Speaker sau khi dọn.`);
    }
  } catch (err) {
    logger.warn(`Không thể dọn bớt khối Speaker thừa: ${err.message}`);
  }
}

/**
 * Ensure the Speech Editor (promptInput) is mounted and ready with strictly 1 speech block.
 * If AI Studio is showing the Zero-State screen (ms-speech-zero-state), automatically
 * clicks the exact "Create new dialog" card ([data-testid="create-new-dialog-card"]).
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
      await ensureSingleSpeechBlock(page, logger);
      return promptMatch;
    }

    // 2. Check if Zero-State screen (ms-speech-zero-state) is shown -> click exact "Create new dialog" card
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
            'mat-card[data-testid="create-new-dialog-card"]',
            '[data-testid="create-new-dialog-card"]',
            'mat-card.create-dialog-card',
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

/**
 * Ensure a specific voice (e.g. "Puck", "Zephyr", "Kore") is selected on the current AI Studio tab.
 * If voiceName is empty, keeps whatever voice is currently active on the page.
 */
async function ensureVoiceSelected(page, voiceName, config, logger) {
  const targetVoice = String(voiceName || '').trim();
  if (!targetVoice) return false;

  const targetLower = targetVoice.toLowerCase();

  // 1. Quick check: read current voice chip label (e.g. "Speaker 1 - Puck")
  const chipSelectors = config.selectors.voiceChipButton || [
    'ms-speech-block button.voice-chip',
    'ms-voice-settings button.active-voice-card-trigger',
  ];
  const chipMatch = await resolveLocator(page, chipSelectors, { visibleOnly: true });
  if (!chipMatch) {
    logger.debug(`Không tìm thấy nút chọn giọng để đặt "${targetVoice}", giữ giọng mặc định.`);
    return false;
  }

  const chipText = ((await chipMatch.locator.innerText().catch(() => '')) || '').trim();
  if (chipText.toLowerCase().includes(targetLower)) {
    logger.debug(`Giọng đọc hiện tại đã khớp "${targetVoice}" (${chipText}).`);
    return true;
  }

  logger.info(`Đang chọn giọng đọc cố định: "${targetVoice}" (hiện tại: "${chipText || 'chưa rõ'}")...`);

  try {
    await chipMatch.locator.click({ timeout: 5000 });
    await page.waitForTimeout(500);

    // 2. If Speaker Settings panel has a search input, filter by voice name
    const searchSelectors = config.selectors.voiceSearchInput || [
      'ms-speaker-settings-panel input[placeholder="Search voices"]',
      'input[aria-label="Search voices"]',
    ];
    const searchMatch = await resolveLocator(page, searchSelectors, { visibleOnly: true });
    if (searchMatch) {
      await searchMatch.locator.fill('');
      await page.waitForTimeout(150);
      await searchMatch.locator.fill(targetVoice);
      await page.waitForTimeout(400);
    }

    // 3. Click the matching voice item in the available voices list / dropdown menu
    const voiceOptionSelectors = [
      `ms-speaker-settings-panel section.voice-list button:has-text("${targetVoice}")`,
      `ms-speaker-settings-panel [role="option"]:has-text("${targetVoice}")`,
      `ms-speaker-settings-panel [class*="voice-card"]:has-text("${targetVoice}")`,
      `ms-speaker-settings-panel button:has-text("${targetVoice}"):not(.voice-chip)`,
      `button[mat-menu-item]:has-text("${targetVoice}")`,
      `mat-option:has-text("${targetVoice}")`,
      `.cdk-overlay-container [role="menuitem"]:has-text("${targetVoice}")`,
      `.cdk-overlay-container [role="option"]:has-text("${targetVoice}")`,
    ];

    const optionMatch = await resolveLocator(page, voiceOptionSelectors, { visibleOnly: true });
    if (optionMatch) {
      await optionMatch.locator.click({ timeout: 5000 });
      await page.waitForTimeout(400);
      logger.success(`Đã chọn giọng đọc: "${targetVoice}"`);
    } else {
      logger.warn(`Không tìm thấy giọng "${targetVoice}" trong danh sách giọng đọc AI Studio.`);
    }
  } catch (err) {
    logger.warn(`Lỗi khi chọn giọng "${targetVoice}": ${err.message}`);
  } finally {
    // Clear search filter if left behind and close speaker panel cleanly
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
    await dismissOverlaysIfPresent(page);
  }

  return true;
}

/**
 * Ensure a specific speaking style (e.g. "Podcast", "Friendly") is selected on the speech block.
 * Works with the inline Style dropdown next to "Speaker 1 - Nika" (as on Gemini 3.8 TTS)
 * and falls back gracefully if the current model doesn't expose that style.
 */
async function ensureStyleSelected(page, styleName, config, logger) {
  const targetStyle = String(styleName || '').trim();
  if (!targetStyle) return false;

  const targetLower = targetStyle.toLowerCase();

  const styleSelectors = config.selectors.styleDropdownButton || [
    'ms-speech-block ms-voice-style-dropdown button',
    'ms-speech-block button[aria-label*="Style" i]',
    'ms-speech-block button[aria-haspopup="menu"]:not(.voice-chip):not(:has-text("Speaker")):not(:has-text("Expression"))',
    'ms-speech-block mat-select',
  ];

  const btnMatch = await resolveLocator(page, styleSelectors, { visibleOnly: true });
  if (!btnMatch) {
    logger.debug(`Không thấy nút chọn Style trực tiếp trên speech block cho "${targetStyle}".`);
    return false;
  }

  const currentText = ((await btnMatch.locator.innerText().catch(() => '')) || '').trim();
  if (currentText.toLowerCase().includes(targetLower)) {
    logger.debug(`Style hiện tại đã khớp "${targetStyle}" (${currentText}).`);
    return true;
  }

  logger.info(`Đang chọn Style: "${targetStyle}" (hiện tại: "${currentText || 'mặc định'}")...`);

  try {
    await btnMatch.locator.click({ timeout: 5000 });
    await page.waitForTimeout(350);

    const optionSelectors = [
      `.cdk-overlay-container button[mat-menu-item]:has-text("${targetStyle}")`,
      `.cdk-overlay-container mat-option:has-text("${targetStyle}")`,
      `.cdk-overlay-container [role="menuitem"]:has-text("${targetStyle}")`,
      `.cdk-overlay-container [role="option"]:has-text("${targetStyle}")`,
      `button[mat-menu-item]:has-text("${targetStyle}")`,
      `mat-option:has-text("${targetStyle}")`,
    ];

    const optMatch = await resolveLocator(page, optionSelectors, { visibleOnly: true });
    if (optMatch) {
      await optMatch.locator.click({ timeout: 5000 });
      await page.waitForTimeout(350);
      logger.success(`Đã chọn Style: "${targetStyle}"`);
      return true;
    }

    logger.warn(`Không tìm thấy Style "${targetStyle}" trong menu của model hiện tại.`);
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  } catch (err) {
    logger.warn(`Lỗi khi chọn Style "${targetStyle}": ${err.message}`);
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

/**
 * Fill the "Scene" field on models that expose it (e.g. gemini-3.1-flash-tts-preview).
 * Silently skips on models that don't have a Scene input.
 */
async function ensureSceneFilled(page, scenePrompt, config, logger) {
  const targetScene = String(scenePrompt || '').trim();
  if (!targetScene) return false;

  const sceneSelectors = config.selectors.sceneInput || [
    'ms-autosize-textarea[arialabel="Scene"] textarea',
    'textarea[aria-label="Scene"]',
    'textarea[placeholder*="bustling street" i]',
  ];

  const match = await resolveLocator(page, sceneSelectors, { visibleOnly: true });
  if (!match) {
    logger.debug('Model hiện tại không có ô nhập Scene, bỏ qua bước điền Scene.');
    return false;
  }

  try {
    const currentVal = (await match.locator.inputValue().catch(() => '')).trim();
    if (currentVal === targetScene) {
      logger.debug('Ô Scene đã khớp sẵn nội dung cấu hình.');
      return true;
    }

    await match.locator.fill(targetScene);
    await match.locator.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    logger.success('Đã tự động điền trường Scene cho model hiện tại.');
    return true;
  } catch (err) {
    logger.warn(`Không thể điền trường Scene: ${err.message}`);
    return false;
  }
}

/**
 * Acquire a dedicated AI Studio Speech tab for a specific worker.
 * - Connects to cdpUrl.
 * - Picks an unclaimed AI Studio tab (not in `claimedPages`), OR opens a brand-new tab if needed
 *   so 2 workers on the same Chrome instance never collide on the same tab!
 */
async function acquireWorkerPage(
  cdpUrl,
  { initialModel, voiceName, voiceStyle, scenePrompt, claimedPages },
  config,
  logger
) {
  logger.info(`Kết nối Chrome CDP tại ${cdpUrl} ...`);
  const browser = await chromium.connectOverCDP(cdpUrl);

  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    await safeDisconnect(browser, logger);
    throw new Error(`Không tìm thấy browser context tại ${cdpUrl}.`);
  }

  const allPages = [];
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      allPages.push(p);
    }
  }

  const targetModel =
    initialModel || (config.ttsModels && config.ttsModels[0]) || 'gemini-3.8-flash-tts';

  // Find an existing AI Studio tab that hasn't been claimed by another worker
  let workerPage = allPages.find(
    (p) => p.url().includes(config.targetUrlPattern) && !claimedPages.has(p)
  );

  if (!workerPage) {
    // Open a dedicated new tab for this worker!
    const newUrl = `https://aistudio.google.com/generate-speech?model=${encodeURIComponent(targetModel)}`;
    logger.info(`Mở tab AI Studio riêng cho tác vụ: ${newUrl}`);
    workerPage = await context.newPage();
    await workerPage.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    logger.success(`Đã nhận tab AI Studio riêng: ${workerPage.url()}`);
  }

  claimedPages.add(workerPage);
  await workerPage.bringToFront().catch(() => {});

  // Ensure editor is mounted (auto-click "Create new dialog" if Zero-State)
  await ensureSpeechEditorReady(workerPage, config, logger, 15000);

  // Switch to requested initial model if needed
  const activeModel = await getCurrentModel(workerPage, config);
  if (initialModel && activeModel !== initialModel) {
    await switchTtsModel(workerPage, initialModel, config, logger);
  }

  // Apply fixed voice, style (e.g. Nika + Podcast), and Scene prompt if supported by current model
  if (voiceName) {
    await ensureVoiceSelected(workerPage, voiceName, config, logger);
  }
  if (voiceStyle) {
    await ensureStyleSelected(workerPage, voiceStyle, config, logger);
  }
  if (scenePrompt) {
    await ensureSceneFilled(workerPage, scenePrompt, config, logger);
  }

  return {
    browser,
    page: workerPage,
    release: async () => {
      claimedPages.delete(workerPage);
      await safeDisconnect(browser, null);
    },
  };
}

/**
 * Quick non-intrusive HTTP probe to check if a Chrome CDP endpoint is online.
 */
function checkCdpEndpoint(cdpUrl, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const u = new URL('/json/version', cdpUrl);
      const req = http.get(u.toString(), { timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const info = JSON.parse(body);
              resolve({ online: true, browser: info.Browser || 'Chrome', cdpUrl });
              return;
            } catch {
              // Ignore parse error
            }
          }
          resolve({ online: false, cdpUrl });
        });
      });
      req.on('error', () => resolve({ online: false, cdpUrl }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ online: false, cdpUrl });
      });
    } catch {
      resolve({ online: false, cdpUrl });
    }
  });
}

function findChromeExecutable() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Google\\Chrome\\Application\\chrome.exe'
      ),
      path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData\\Local'),
        'Google\\Chrome\\Application\\chrome.exe'
      ),
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }
  if (process.platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return fs.existsSync(macPath) ? macPath : null;
  }
  return 'google-chrome';
}

/**
 * Launch a dedicated Chrome Debug window for any profile (custom port & dirName).
 */
function launchChromeDebugInstance({
  port = 9222,
  profileSlot = 1,
  dirName = '',
  model = 'gemini-3.8-flash-tts',
} = {}) {
  const chromeExe = findChromeExecutable();
  if (!chromeExe) {
    throw new Error('Không tìm thấy Google Chrome trên máy tính.');
  }

  const baseAppData =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : os.homedir();

  let folderName = String(dirName || '').trim();
  if (!folderName) {
    folderName =
      profileSlot === 1 && Number(port) === 9222
        ? 'aistudio-tts-chrome-profile'
        : `aistudio-tts-chrome-profile-${port}`;
  }
  if (process.platform !== 'win32' && !folderName.startsWith('.')) {
    folderName = `.${folderName}`;
  }

  const profileDir = path.join(baseAppData, folderName);
  fs.mkdirSync(profileDir, { recursive: true });

  const targetUrl = `https://aistudio.google.com/generate-speech?model=${encodeURIComponent(model)}`;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    targetUrl,
  ];

  const child = spawn(chromeExe, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return { port, profileDir, targetUrl };
}

module.exports = {
  connectToAIStudio,
  safeDisconnect,
  resolveLocator,
  inspectPage,
  ensureSpeechEditorReady,
  ensureSingleSpeechBlock,
  ensureVoiceSelected,
  ensureStyleSelected,
  ensureSceneFilled,
  acquireWorkerPage,
  checkCdpEndpoint,
  launchChromeDebugInstance,
  getCurrentModel,
  switchTtsModel,
};
