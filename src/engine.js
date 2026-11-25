const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const baseConfig = require('../config');
const Logger = require('./logger');
const { KeyedMutex } = require('./mutex');
const { loadSettings } = require('./settingsStore');
const {
  ensureDirectories,
  getInputFiles,
  readTextFile,
  splitTextIntoParts,
  findExistingAudio,
  loadFailedEntries,
  recordFailedFile,
  clearFailedFile,
  isFilePublished,
  isChapterCompletedInLog,
  recordPublishedFile,
  cleanupAudioFiles,
  groupOutputAudioByChapter,
} = require('./fileManager');
const {
  acquireWorkerPage,
  ensureVoiceSelected,
  ensureStyleSelected,
  ensureSceneFilled,
  getCurrentModel,
  switchTtsModel,
  checkCdpEndpoint,
  launchChromeDebugInstance,
} = require('./browser');
const { processSingleFile } = require('./automation');
const { publishAudioToCms } = require('./publisher');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function normalizeUrlBase(url) {
  return String(url || '')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/+$/, '');
}

class AutomationEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle'; // 'idle' | 'running' | 'stopping'
    this.runMode = 'batch'; // 'batch' | 'retry-failed' | 'publish-only'
    this.stopRequested = false;

    this.uiLocks = new KeyedMutex(); // Keyed by cdpUrl
    this.cmsLocks = new KeyedMutex(); // Keyed by normalized publishUrl
    this.claimedPages = new Set();

    // Per-CDP model cooldown maps: Map<cdpUrl, Map<modelName, cooldownUntilMs>>
    this.cooldownsByCdp = new Map();
    // Per-Chrome-Profile cooldown map: Map<cdpUrl, cooldownUntilMs>
    this.profileCooldownUntil = new Map();

    this.recentLogs = [];
    this.maxRecentLogs = 400;

    this.stats = this._emptyStats();
    this.workersState = this._emptyWorkersState(2);
    this.chapterDurationsMs = [];

    this.rootLogger = new Logger(baseConfig.logsDir, {
      onLog: (entry) => this._pushLog(entry),
    });
  }

  _emptyStats() {
    return {
      totalChapters: 0,
      completedChapters: 0,
      partsSucceeded: 0,
      publishedChapters: 0,
      skippedChapters: 0,
      failedChapters: 0,
      startedAt: null,
      finishedAt: null,
      etaSeconds: null,
    };
  }

  _emptyWorkersState(count = 2) {
    return Array.from({ length: count }, (_, idx) => ({
      id: idx + 1,
      name: `Tác vụ ${idx + 1}`,
      active: false,
      phase: 'idle', // 'idle' | 'connecting' | 'generating' | 'waiting_cms' | 'publishing' | 'cooldown' | 'switching_model' | 'stopped' | 'done' | 'error'
      cdpUrl: '',
      currentModel: '',
      voiceName: '',
      currentFile: '',
      currentPart: 0,
      totalParts: 0,
      partStartedAt: null,
      chaptersDone: 0,
      chaptersFailed: 0,
      lastMessage: 'Sẵn sàng',
    }));
  }

  _pushLog(entry) {
    this.recentLogs.push(entry);
    if (this.recentLogs.length > this.maxRecentLogs) {
      this.recentLogs.shift();
    }
    this.emit('log', entry);
  }

  clearLogs() {
    this.recentLogs = [];
    this.emit('state', this.getSnapshot());
  }

  _updateWorker(workerId, patch) {
    const idx = workerId - 1;
    if (this.workersState[idx]) {
      Object.assign(this.workersState[idx], patch);
      this._emitState();
    }
  }

  _recomputeEta(activeWorkersCount) {
    const remaining =
      this.stats.totalChapters -
      (this.stats.completedChapters + this.stats.skippedChapters + this.stats.failedChapters);
    if (remaining <= 0 || this.chapterDurationsMs.length === 0) {
      this.stats.etaSeconds = remaining <= 0 ? 0 : null;
      return;
    }
    const avgMs =
      this.chapterDurationsMs.reduce((acc, v) => acc + v, 0) / this.chapterDurationsMs.length;
    const parallelism = Math.max(1, activeWorkersCount);
    this.stats.etaSeconds = Math.round(((remaining * avgMs) / parallelism) / 1000);
  }

  _getCooldownMap(cdpUrl) {
    const key = String(cdpUrl || 'default');
    let map = this.cooldownsByCdp.get(key);
    if (!map) {
      map = new Map();
      this.cooldownsByCdp.set(key, map);
    }
    return map;
  }

  getModelHealthSnapshot(settings) {
    const models = settings?.enabledModels?.length ? settings.enabledModels : baseConfig.ttsModels;
    const now = Date.now();
    const activeByModel = new Map();
    for (const w of this.workersState) {
      if (w.active && w.currentModel) {
        const list = activeByModel.get(w.currentModel) || [];
        list.push(`Tác vụ ${w.id}`);
        activeByModel.set(w.currentModel, list);
      }
    }

    return models.map((model) => {
      let maxCoolUntil = 0;
      for (const map of this.cooldownsByCdp.values()) {
        const t = map.get(model) || 0;
        if (t > maxCoolUntil) maxCoolUntil = t;
      }
      const cooldownRemainingSec = maxCoolUntil > now ? Math.ceil((maxCoolUntil - now) / 1000) : 0;
      return {
        model,
        inUseBy: activeByModel.get(model) || [],
        cooldownRemainingSec,
        status:
          cooldownRemainingSec > 0
            ? 'cooldown'
            : (activeByModel.get(model) || []).length > 0
              ? 'in_use'
              : 'ready',
      };
    });
  }

  getProfileCooldownsSnapshot(settings) {
    const now = Date.now();
    const out = {};
    for (const p of settings?.chromeProfiles || []) {
      const url = `http://127.0.0.1:${p.port}`;
      const until = this.profileCooldownUntil.get(url) || 0;
      out[url] = until > now ? Math.ceil((until - now) / 1000) : 0;
    }
    return out;
  }

  resetProfileCooldown(cdpUrl) {
    if (cdpUrl) {
      this.profileCooldownUntil.delete(cdpUrl);
      this.cooldownsByCdp.delete(cdpUrl);
    } else {
      this.profileCooldownUntil.clear();
      this.cooldownsByCdp.clear();
    }
    this._emitState();
  }

  getSnapshot() {
    const settings = loadSettings(baseConfig.logsDir);
    return {
      status: this.status,
      runMode: this.runMode,
      stats: { ...this.stats },
      workers: this.workersState.map((w) => ({ ...w })),
      modelsHealth: this.getModelHealthSnapshot(settings),
      profileCooldowns: this.getProfileCooldownsSnapshot(settings),
      failedCount: loadFailedEntries(baseConfig.logsDir).length,
    };
  }

  _emitState() {
    this.emit('state', this.getSnapshot());
  }

  async _interruptibleSleep(ms) {
    const step = 400;
    let remaining = ms;
    while (remaining > 0 && !this.stopRequested) {
      await sleep(Math.min(step, remaining));
      remaining -= step;
    }
  }

  _pickNextModel(currentModel, triedSet, enabledModels, cdpUrl, workerId) {
    if (!Array.isArray(enabledModels) || enabledModels.length <= 1) return null;
    const cooldownMap = this._getCooldownMap(cdpUrl);
    const now = Date.now();
    const startIdx = Math.max(0, enabledModels.indexOf(currentModel));

    // Models currently used by sibling workers on the SAME Chrome CDP instance
    const siblingModels = new Set(
      this.workersState
        .filter((w) => w.id !== workerId && w.active && w.cdpUrl === cdpUrl && w.currentModel)
        .map((w) => w.currentModel)
    );

    // Pass 1: prefer available model not used by sibling on same Chrome
    for (let pass = 1; pass <= 2; pass++) {
      for (let offset = 1; offset <= enabledModels.length; offset++) {
        const candidate = enabledModels[(startIdx + offset) % enabledModels.length];
        if (triedSet.has(candidate)) continue;
        if ((cooldownMap.get(candidate) || 0) > now) continue;
        if (pass === 1 && siblingModels.has(candidate)) continue;
        return candidate;
      }
    }
    return null;
  }

  _pickLeastCooledModel(enabledModels, cdpUrl) {
    if (!Array.isArray(enabledModels) || enabledModels.length === 0) return null;
    const cooldownMap = this._getCooldownMap(cdpUrl);
    let best = enabledModels[0];
    let bestTime = cooldownMap.get(best) || 0;
    for (const m of enabledModels) {
      const t = cooldownMap.get(m) || 0;
      if (t < bestTime) {
        bestTime = t;
        best = m;
      }
    }
    return best;
  }

  /**
   * Pick the next available Chrome profile when the current profile hits its account/quota limit.
   * Prefers profiles that are: (1) not in cooldown, (2) not actively used by sibling worker, (3) already Online.
   * If none are Online and `autoLaunchProfileOnRotate` is enabled, launches the next non-cooldown profile.
   */
  async _pickNextProfile(currentCdpUrl, settings, workerId, wLogger) {
    const profiles = Array.isArray(settings.chromeProfiles) ? settings.chromeProfiles : [];
    if (profiles.length <= 1) return null;

    const now = Date.now();
    const currentIdx = Math.max(
      0,
      profiles.findIndex((p) => `http://127.0.0.1:${p.port}` === currentCdpUrl)
    );

    const siblingUrls = new Set(
      this.workersState
        .filter((w) => w.id !== workerId && w.active && w.cdpUrl)
        .map((w) => w.cdpUrl)
    );

    // Build circularly ordered candidates (excluding current profile and profiles in cooldown)
    const candidates = [];
    for (let offset = 1; offset < profiles.length; offset++) {
      const p = profiles[(currentIdx + offset) % profiles.length];
      const url = `http://127.0.0.1:${p.port}`;
      if ((this.profileCooldownUntil.get(url) || 0) > now) continue;
      candidates.push({ profile: p, url, isSiblingUsing: siblingUrls.has(url) });
    }

    if (candidates.length === 0) return null;

    // Sort: free profiles (not used by sibling) first
    candidates.sort((a, b) => Number(a.isSiblingUsing) - Number(b.isSiblingUsing));

    // Pass 1: look for a candidate that is already Online
    for (const cand of candidates) {
      const probe = await checkCdpEndpoint(cand.url, 1500);
      if (probe.online) {
        return cand;
      }
    }

    // Pass 2: if allowed, auto-launch the top candidate profile and wait for CDP to come up
    if (settings.autoLaunchProfileOnRotate) {
      const target = candidates[0];
      const firstModel =
        (settings.enabledModels && settings.enabledModels[0]) || 'gemini-3.8-flash-tts';
      wLogger.warn(
        `Hồ sơ "${target.profile.name}" (:${target.profile.port}) đang tắt -> tự động mở Chrome Debug...`
      );
      try {
        launchChromeDebugInstance({
          port: target.profile.port,
          dirName: target.profile.dirName,
          model: firstModel,
        });

        const waitDeadline = Date.now() + 12000;
        while (Date.now() < waitDeadline && !this.stopRequested) {
          await sleep(800);
          const probe = await checkCdpEndpoint(target.url, 1500);
          if (probe.online) {
            return target;
          }
        }
      } catch (err) {
        wLogger.error(`Không thể tự mở hồ sơ "${target.profile.name}": ${err.message}`);
      }
    }

    return null;
  }

  _buildRuntimeConfig(settings, workerCfg) {
    const enabledModels =
      Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0
        ? settings.enabledModels
        : baseConfig.ttsModels;

    return {
      ...baseConfig,
      cdpUrl: workerCfg.cdpUrl || baseConfig.cdpUrl,
      inputDir: path.resolve(workerCfg.inputDir || baseConfig.inputDir),
      outputDir: path.resolve(workerCfg.outputDir || baseConfig.outputDir),
      ttsModels: enabledModels,
      rotateModelOnQuotaError: Boolean(settings.rotateModelOnQuotaError),
      rotateModelPerChapter: Boolean(settings.rotateModelPerChapter),
      modelCooldownMs: Math.max(10, Number(settings.modelCooldownSec || 300)) * 1000,
      splitParts: Math.max(1, Number(settings.splitParts || 4)),
      minCharsPerSplit: Math.max(50, Number(settings.minCharsPerSplit || 300)),
      maxWaitAudioMs: Math.max(30, Number(settings.maxWaitAudioSec || 600)) * 1000,
      minDelayMs: Math.max(0, Number(settings.minDelaySec ?? 5)) * 1000,
      maxDelayMs: Math.max(0, Number(settings.maxDelaySec ?? 10)) * 1000,
      maxRetries: Math.max(0, Number(settings.maxRetries ?? 2)),
      rateLimitCooldownMs: Math.max(5, Number(settings.rateLimitCooldownSec || 60)) * 1000,
      stopOnQuotaError: Boolean(settings.stopOnQuotaError),
      stopOnAccountVerifyError: Boolean(settings.stopOnAccountVerifyError),
      cleanupAudioAfterPublish: Boolean(settings.cleanupAudioAfterPublish),
      publish: {
        ...baseConfig.publish,
        enabled: Boolean(settings.publishEnabled),
        chaptersUrl: workerCfg.publishUrl || baseConfig.publish.chaptersUrl,
        autoMerge: Boolean(settings.autoMerge),
        mergeGap: String(settings.mergeGap ?? '0.4'),
        aacBitrate: String(settings.aacBitrate || '48k'),
        maxWaitUploadMs: Math.max(30, Number(settings.maxWaitUploadSec || 300)) * 1000,
      },
    };
  }

  stop() {
    if (this.status !== 'running') return false;
    this.stopRequested = true;
    this.status = 'stopping';
    this.rootLogger.warn('Nhận lệnh DỪNG từ giao diện. Đang dừng an toàn các tác vụ...');
    this._emitState();
    return true;
  }

  async start(mode = 'batch') {
    if (this.status !== 'idle') {
      throw new Error('Hệ thống đang chạy, vui lòng dừng trước khi bắt đầu lượt mới.');
    }

    const settings = loadSettings(baseConfig.logsDir);
    this.status = 'running';
    this.runMode = mode;
    this.stopRequested = false;
    this.claimedPages.clear();
    this.chapterDurationsMs = [];
    this.stats = this._emptyStats();
    this.stats.startedAt = new Date().toISOString();

    const workerCount = Math.min(2, Math.max(1, Number(settings.workerCount || 1)));
    this.workersState = this._emptyWorkersState(2);
    this._emitState();

    // Run asynchronously without blocking HTTP request
    this._runOrchestration(settings, workerCount, mode).catch((err) => {
      this.rootLogger.error(`Lỗi điều phối hệ thống: ${err.message}`);
      this.status = 'idle';
      this._emitState();
    });

    return this.getSnapshot();
  }

  async _runOrchestration(settings, workerCount, mode) {
    try {
      if (mode === 'publish-only') {
        await this._runPublishOnly(settings);
        return;
      }

      const isShared = settings.queueMode !== 'independent' || workerCount === 1;
      const activeWorkersCfg = settings.workers.slice(0, workerCount).map((w, idx) => ({
        ...w,
        // In shared mode, worker 2 shares worker 1's input/output/publishUrl
        ...(isShared && idx > 0
          ? {
              inputDir: settings.workers[0].inputDir,
              outputDir: settings.workers[0].outputDir,
              publishUrl: settings.workers[0].publishUrl,
            }
          : {}),
      }));

      // If 2 workers share 1 Chrome and picked the exact same initialModel, stagger Worker 2!
      if (
        workerCount === 2 &&
        activeWorkersCfg[0].cdpUrl === activeWorkersCfg[1].cdpUrl &&
        activeWorkersCfg[0].initialModel === activeWorkersCfg[1].initialModel &&
        settings.enabledModels.length > 1
      ) {
        const nextIdx =
          (Math.max(0, settings.enabledModels.indexOf(activeWorkersCfg[0].initialModel)) + 1) %
          settings.enabledModels.length;
        activeWorkersCfg[1].initialModel = settings.enabledModels[nextIdx];
      }

      // Build queues
      let queuesByWorker;
      if (isShared) {
        const primaryInputDir = path.resolve(activeWorkersCfg[0].inputDir || baseConfig.inputDir);
        const primaryOutputDir = path.resolve(activeWorkersCfg[0].outputDir || baseConfig.outputDir);
        ensureDirectories([primaryInputDir, primaryOutputDir, baseConfig.logsDir]);

        let files = getInputFiles(primaryInputDir);
        if (mode === 'retry-failed') {
          const failedSet = new Set(loadFailedEntries(baseConfig.logsDir).map((e) => e.fileName));
          files = files.filter((f) => failedSet.has(f.fileName));
        }

        const sharedQueue = files.map((file, index) => ({
          file,
          index: index + 1,
          total: files.length,
        }));
        this.stats.totalChapters = sharedQueue.length;
        queuesByWorker = activeWorkersCfg.map(() => sharedQueue);
      } else {
        queuesByWorker = activeWorkersCfg.map((w) => {
          const inDir = path.resolve(w.inputDir || baseConfig.inputDir);
          const outDir = path.resolve(w.outputDir || baseConfig.outputDir);
          ensureDirectories([inDir, outDir, baseConfig.logsDir]);
          let files = getInputFiles(inDir);
          if (mode === 'retry-failed') {
            const failedSet = new Set(loadFailedEntries(baseConfig.logsDir).map((e) => e.fileName));
            files = files.filter((f) => failedSet.has(f.fileName));
          }
          return files.map((file, index) => ({
            file,
            index: index + 1,
            total: files.length,
          }));
        });
        this.stats.totalChapters = queuesByWorker.reduce((sum, q) => sum + q.length, 0);
      }

      if (this.stats.totalChapters === 0) {
        this.rootLogger.warn('Không tìm thấy file .txt nào cần xử lý.');
        return;
      }

      const limitTotal = Number(settings.limitChapters || 0) > 0 ? Number(settings.limitChapters) : null;
      const sharedClaimedCounter = { processed: 0 };

      this.rootLogger.info(
        `Khởi chạy ${workerCount} tác vụ (${isShared ? 'Hàng đợi chung 1 truyện' : '2 Truyện độc lập'}) | Tổng: ${this.stats.totalChapters} file .txt`
      );
      this._emitState();

      await Promise.all(
        activeWorkersCfg.map((wCfg, idx) =>
          this._runSingleWorker({
            workerId: idx + 1,
            workerCfg: wCfg,
            settings,
            queue: queuesByWorker[idx],
            limitTotal,
            sharedClaimedCounter,
            activeWorkersCount: workerCount,
          })
        )
      );
    } finally {
      this.stats.finishedAt = new Date().toISOString();
      this.stats.etaSeconds = 0;
      this.status = 'idle';
      this.stopRequested = false;

      this.rootLogger.info(
        `=== KẾT THÚC LƯỢT CHẠY === Xong: ${this.stats.completedChapters} | Đã đăng CMS: ${this.stats.publishedChapters} | Bỏ qua: ${this.stats.skippedChapters} | Lỗi: ${this.stats.failedChapters}`
      );
      this._emitState();
    }
  }

  async _runPublishOnly(settings) {
    const wCfg = settings.workers[0];
    const runtimeConfig = this._buildRuntimeConfig(settings, wCfg);
    runtimeConfig.publish.enabled = true;

    const wLogger = this.rootLogger.child({ prefix: '[Chỉ Đăng CMS]', workerId: 1 });
    ensureDirectories([runtimeConfig.outputDir, runtimeConfig.logsDir]);

    // Group output/*.wav files by chapter (e.g. Chương 1435_1.._8 -> 1 chapter bundle for Auto-Merge)
    const chapterGroups = groupOutputAudioByChapter(
      runtimeConfig.outputDir,
      runtimeConfig.supportedAudioExtensions
    );

    this.stats.totalChapters = chapterGroups.length;
    if (chapterGroups.length === 0) {
      wLogger.warn(`Không tìm thấy file audio nào trong ${runtimeConfig.outputDir}`);
      return;
    }

    const totalFilesCount = chapterGroups.reduce((sum, g) => sum + g.files.length, 0);
    wLogger.info(
      `Quét thấy ${totalFilesCount} file audio -> gom thành ${chapterGroups.length} chương` +
        (runtimeConfig.publish.autoMerge ? ' (Auto-Merge: BẬT)' : ' (Auto-Merge: TẮT)')
    );

    // Find an online Chrome CDP endpoint (try Worker 1's profile first, then any online profile)
    let activeCdpUrl = runtimeConfig.cdpUrl;
    const primaryProbe = await checkCdpEndpoint(activeCdpUrl, 1500);
    if (!primaryProbe.online) {
      for (const p of settings.chromeProfiles || []) {
        const candUrl = `http://127.0.0.1:${p.port}`;
        const probe = await checkCdpEndpoint(candUrl, 1500);
        if (probe.online) {
          wLogger.info(`Hồ sơ mặc định đang tắt -> tự động dùng hồ sơ "${p.name}" (${candUrl}) đang Online.`);
          activeCdpUrl = candUrl;
          break;
        }
      }
    }

    const { chromium } = require('playwright-core');
    this._updateWorker(1, {
      active: true,
      phase: 'connecting',
      cdpUrl: activeCdpUrl,
      currentModel: 'CMS Bulk Upload',
      lastMessage: `Đang kết nối Chrome CDP (${activeCdpUrl})...`,
    });

    const limitTotal = Number(settings.limitChapters || 0) > 0 ? Number(settings.limitChapters) : null;
    let processedCount = 0;

    let browser;
    try {
      browser = await chromium.connectOverCDP(activeCdpUrl);

      for (let i = 0; i < chapterGroups.length; i++) {
        if (this.stopRequested) break;
        if (limitTotal !== null && processedCount >= limitTotal) {
          wLogger.info(`Đã đạt giới hạn ${limitTotal} chương. Dừng.`);
          break;
        }

        const group = chapterGroups[i];
        const prefix = `[${i + 1}/${chapterGroups.length}] ${group.chapterBaseName}`;

        // Skip already-published chapters unless --force
        if (
          !settings.forceRerun &&
          isChapterCompletedInLog(runtimeConfig.logsDir, group.chapterBaseName, group.files.length)
        ) {
          this.stats.skippedChapters += 1;
          wLogger.skip(`${prefix} (${group.files.length} file) -> đã đăng CMS trước đó.`);
          this._recomputeEta(1);
          this._emitState();
          continue;
        }

        if (group.hasSequenceGap) {
          wLogger.warn(
            `${prefix} -> CẢNH BÁO: thiếu phần ở giữa chuỗi (${group.files.map((f) => f.partNumber).join(', ')}). Vẫn tiến hành đăng các phần hiện có...`
          );
        }

        processedCount += 1;
        const chapterStartedAt = Date.now();
        const filePaths = group.files.map((f) => f.fullPath);

        this._updateWorker(1, {
          phase: 'publishing',
          currentFile: `${group.chapterBaseName} (${group.files.length} file • ${formatSize(group.totalSize)})`,
          currentPart: group.files.length,
          totalParts: group.files.length,
          partStartedAt: new Date().toISOString(),
          lastMessage: `Đang ghép & đăng ${group.files.length} phần lên CMS...`,
        });

        let publishedOk = false;
        let lastErr = null;
        const maxAttempts = 2;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (this.stopRequested) break;
          try {
            await publishAudioToCms(
              browser,
              null,
              runtimeConfig,
              filePaths,
              wLogger,
              () => this.stopRequested,
              {
                expectedChaptersAdded: runtimeConfig.publish.autoMerge ? 1 : group.files.length,
              }
            );
            publishedOk = true;
            break;
          } catch (err) {
            lastErr = err;
            wLogger.error(`${prefix} -> lỗi đăng CMS (lần ${attempt}/${maxAttempts}): ${err.message}`);
            if (attempt < maxAttempts && !this.stopRequested) {
              wLogger.warn('Chờ 5s trước khi thử đăng lại chương này...');
              await this._interruptibleSleep(5000);
            }
          }
        }

        if (publishedOk && !this.stopRequested) {
          for (const f of group.files) {
            recordPublishedFile(runtimeConfig.logsDir, {
              baseName: f.baseName,
              chapterBaseName: group.chapterBaseName,
              audioFileName: f.fileName,
              publishUrl: runtimeConfig.publish.chaptersUrl,
            });
          }
          recordPublishedFile(runtimeConfig.logsDir, {
            baseName: group.chapterBaseName,
            chapterBaseName: group.chapterBaseName,
            audioFileName: `${group.chapterBaseName} (${group.files.length} parts)`,
            publishUrl: runtimeConfig.publish.chaptersUrl,
          });
          clearFailedFile(runtimeConfig.logsDir, `${group.chapterBaseName}.txt`);

          if (runtimeConfig.cleanupAudioAfterPublish) {
            cleanupAudioFiles(filePaths, wLogger);
          }

          this.stats.publishedChapters += 1;
          this.stats.completedChapters += 1;
          this.chapterDurationsMs.push(Date.now() - chapterStartedAt);
          if (this.chapterDurationsMs.length > 20) this.chapterDurationsMs.shift();
          this._recomputeEta(1);

          this._updateWorker(1, {
            chaptersDone: this.workersState[0].chaptersDone + 1,
            lastMessage: `Đăng xong ${group.chapterBaseName}`,
          });
        } else if (!publishedOk && !this.stopRequested) {
          recordFailedFile(
            runtimeConfig.logsDir,
            `${group.chapterBaseName}.txt`,
            `Publish-only error: ${lastErr ? lastErr.message : 'Unknown error'}`
          );
          this.stats.failedChapters += 1;
          this._updateWorker(1, {
            chaptersFailed: this.workersState[0].chaptersFailed + 1,
            lastMessage: `Lỗi đăng ${group.chapterBaseName}`,
          });
        }

        this._emitState();

        // Short 2s pause between chapters so CMS finishes state reset cleanly
        if (i < chapterGroups.length - 1 && !this.stopRequested) {
          await this._interruptibleSleep(2000);
        }
      }
    } catch (err) {
      wLogger.error(`Lỗi kết nối Chrome CDP (${activeCdpUrl}): ${err.message}`);
      this.stats.failedChapters += 1;
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
      this._updateWorker(1, {
        active: false,
        phase: this.stopRequested ? 'stopped' : 'done',
        partStartedAt: null,
        lastMessage: this.stopRequested ? 'Đã dừng an toàn' : 'Hoàn tất Chỉ Đăng CMS',
      });
    }
  }

  async _runSingleWorker({
    workerId,
    workerCfg,
    settings,
    queue,
    limitTotal,
    sharedClaimedCounter,
    activeWorkersCount,
  }) {
    const runtimeConfig = this._buildRuntimeConfig(settings, workerCfg);
    const effectiveVoice = String(workerCfg.voiceName || settings.voiceName || '').trim();
    const effectiveStyle = String(workerCfg.voiceStyle || settings.voiceStyle || '').trim();
    const effectiveScene = String(settings.scenePrompt || '').trim();
    const wLogger = this.rootLogger.child({
      prefix: `[Tác vụ ${workerId}]`,
      workerId,
    });

    const initialModel =
      workerCfg.initialModel && runtimeConfig.ttsModels.includes(workerCfg.initialModel)
        ? workerCfg.initialModel
        : runtimeConfig.ttsModels[0];

    this._updateWorker(workerId, {
      active: true,
      phase: 'connecting',
      cdpUrl: runtimeConfig.cdpUrl,
      currentModel: initialModel,
      voiceName: [effectiveVoice || 'Mặc định', effectiveStyle].filter(Boolean).join(' • '),
      lastMessage: `Đang kết nối ${runtimeConfig.cdpUrl}...`,
    });

    let session;
    try {
      session = await this.uiLocks.runExclusive(runtimeConfig.cdpUrl, () =>
        acquireWorkerPage(
          runtimeConfig.cdpUrl,
          {
            initialModel,
            voiceName: effectiveVoice,
            voiceStyle: effectiveStyle,
            scenePrompt: effectiveScene,
            claimedPages: this.claimedPages,
          },
          runtimeConfig,
          wLogger
        )
      );
    } catch (err) {
      wLogger.error(`Không thể khởi tạo trình duyệt tại ${runtimeConfig.cdpUrl}: ${err.message}`);
      this._updateWorker(workerId, {
        active: false,
        phase: 'error',
        lastMessage: `Lỗi kết nối CDP: ${err.message}`,
      });
      return;
    }

    let { browser, page, release } = session;
    let currentModel = await getCurrentModel(page, runtimeConfig);
    this._updateWorker(workerId, {
      currentModel,
      phase: 'idle',
      lastMessage: 'Đã kết nối, bắt đầu lấy chương...',
    });

    const tryRotateToAnotherProfile = async (reasonLabel) => {
      if (!settings.rotateProfileOnLimit) return false;
      const coolMs = Math.max(1, Number(settings.profileCooldownMin || 30)) * 60 * 1000;
      const oldUrl = runtimeConfig.cdpUrl;
      this.profileCooldownUntil.set(oldUrl, Date.now() + coolMs);
      this._emitState();

      wLogger.warn(
        `Hồ sơ hiện tại (${oldUrl}) ${reasonLabel} -> tạm nghỉ ${Math.round(coolMs / 60000)} phút và tìm hồ sơ Chrome khả dụng khác...`
      );

      const nextCand = await this._pickNextProfile(oldUrl, settings, workerId, wLogger);
      if (!nextCand) {
        wLogger.warn('Không còn hồ sơ Chrome khả dụng nào khác ngoài cooldown.');
        return false;
      }

      this._updateWorker(workerId, {
        phase: 'switching_profile',
        lastMessage: `Đang chuyển sang hồ sơ "${nextCand.profile.name}" (:${nextCand.profile.port})...`,
      });

      try {
        await release();
        const freshModel = runtimeConfig.ttsModels[0] || currentModel;
        const newSession = await this.uiLocks.runExclusive(nextCand.url, () =>
          acquireWorkerPage(
            nextCand.url,
            {
              initialModel: freshModel,
              voiceName: effectiveVoice,
              voiceStyle: effectiveStyle,
              scenePrompt: effectiveScene,
              claimedPages: this.claimedPages,
            },
            runtimeConfig,
            wLogger
          )
        );

        browser = newSession.browser;
        page = newSession.page;
        release = newSession.release;
        runtimeConfig.cdpUrl = nextCand.url;
        currentModel = await getCurrentModel(page, runtimeConfig);

        wLogger.success(
          `Đã luân phiên sang hồ sơ "${nextCand.profile.name}" (${nextCand.url}) | Model: ${currentModel}`
        );
        this._updateWorker(workerId, {
          cdpUrl: nextCand.url,
          currentModel,
          phase: 'generating',
          lastMessage: `Đã chuyển sang ${nextCand.profile.name} (:${nextCand.profile.port})`,
        });
        return true;
      } catch (rotErr) {
        wLogger.error(`Lỗi khi chuyển sang hồ sơ "${nextCand.profile.name}": ${rotErr.message}`);
        return false;
      }
    };

    try {
      while (!this.stopRequested) {
        if (limitTotal !== null && sharedClaimedCounter.processed >= limitTotal) {
          wLogger.info(`Đã đạt giới hạn ${limitTotal} chương.`);
          break;
        }

        const job = queue.shift();
        if (!job) break;

        const { file, index, total } = job;
        const filePrefix = `[${index}/${total}] ${file.fileName}`;

        // Read & split chapter text first so we know expected part count
        let text;
        try {
          text = readTextFile(file.fullPath);
        } catch (err) {
          wLogger.error(`${filePrefix} -> lỗi đọc file: ${err.message}`);
          recordFailedFile(runtimeConfig.logsDir, file.fileName, `Read error: ${err.message}`);
          this.stats.failedChapters += 1;
          this._emitState();
          continue;
        }

        if (!text) {
          wLogger.skip(`${filePrefix} -> file rỗng, bỏ qua.`);
          this.stats.skippedChapters += 1;
          this._emitState();
          continue;
        }

        const parts = splitTextIntoParts(
          text,
          runtimeConfig.splitParts,
          runtimeConfig.minCharsPerSplit
        );
        const useSuffix = runtimeConfig.splitParts > 1 && parts.length > 1;

        // Smart skip check (works even if .wav files were cleaned up after CMS publish!)
        if (!settings.forceRerun) {
          if (
            runtimeConfig.publish.enabled &&
            isChapterCompletedInLog(runtimeConfig.logsDir, file.baseName, useSuffix ? parts.length : 1)
          ) {
            wLogger.skip(`${filePrefix} -> đã đăng CMS hoàn tất trước đó.`);
            this.stats.skippedChapters += 1;
            clearFailedFile(runtimeConfig.logsDir, file.fileName);
            this._recomputeEta(activeWorkersCount);
            this._emitState();
            continue;
          }

          const legacyAudio = findExistingAudio(
            runtimeConfig.outputDir,
            file.baseName,
            runtimeConfig.supportedAudioExtensions
          );
          if (legacyAudio && !runtimeConfig.publish.enabled) {
            wLogger.skip(`${filePrefix} -> đã có ${legacyAudio.fileName}.`);
            this.stats.skippedChapters += 1;
            clearFailedFile(runtimeConfig.logsDir, file.fileName);
            this._recomputeEta(activeWorkersCount);
            this._emitState();
            continue;
          }

          const allPartsReady = parts.every((_, idx) => {
            const pBase = useSuffix ? `${file.baseName}_${idx + 1}` : file.baseName;
            const existing = findExistingAudio(
              runtimeConfig.outputDir,
              pBase,
              runtimeConfig.supportedAudioExtensions
            );
            if (!existing) return false;
            return !runtimeConfig.publish.enabled || isFilePublished(runtimeConfig.logsDir, pBase);
          });

          if (allPartsReady) {
            wLogger.skip(`${filePrefix} -> đã hoàn tất đủ ${parts.length}/${parts.length} phần.`);
            this.stats.skippedChapters += 1;
            clearFailedFile(runtimeConfig.logsDir, file.fileName);
            this._recomputeEta(activeWorkersCount);
            this._emitState();
            continue;
          }
        }

        // Claim a slot against limitTotal
        if (limitTotal !== null) {
          if (sharedClaimedCounter.processed >= limitTotal) {
            queue.unshift(job);
            break;
          }
          sharedClaimedCounter.processed += 1;
        }

        const chapterStartedAt = Date.now();
        wLogger.info(
          `${filePrefix} -> ${text.length} ký tự, chia ${parts.length} phần | Model: ${currentModel}`
        );

        let fileHasFailure = false;
        let fileLastError = null;
        let stopWorkerFatal = false;
        const chapterPartAudios = [];

        // Phase A: Generate all parts of this chapter
        for (let pIdx = 0; pIdx < parts.length; pIdx++) {
          if (this.stopRequested) break;

          const partNum = pIdx + 1;
          const partText = parts[pIdx];
          const partBaseName = useSuffix ? `${file.baseName}_${partNum}` : file.baseName;
          const partPrefix = useSuffix
            ? `${filePrefix} [Phần ${partNum}/${parts.length}]`
            : filePrefix;

          this._updateWorker(workerId, {
            phase: 'generating',
            currentFile: file.fileName,
            currentPart: partNum,
            totalParts: parts.length,
            partStartedAt: new Date().toISOString(),
            lastMessage: `Đang xử lý phần ${partNum}/${parts.length} (${partText.length} ký tự)`,
          });

          if (!settings.forceRerun) {
            const existingPart = findExistingAudio(
              runtimeConfig.outputDir,
              partBaseName,
              runtimeConfig.supportedAudioExtensions
            );
            if (existingPart) {
              wLogger.skip(
                `${partPrefix} -> đã có sẵn ${existingPart.fileName} (${formatSize(existingPart.size)})`
              );
              chapterPartAudios.push({
                baseName: partBaseName,
                fileName: existingPart.fileName,
                fullPath: existingPart.path,
              });
              continue;
            }
          }

          let savedAudioPath = null;
          let lastError = null;
          const maxAttempts = runtimeConfig.maxRetries + 1;
          const triedModelsForPart = new Set([currentModel]);
          let modelSwitches = 0;
          let profileSwitches = 0;
          const maxProfileSwitches = Math.max(1, (settings.chromeProfiles || []).length);

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (this.stopRequested) break;

            try {
              const result = await processSingleFile(
                page,
                runtimeConfig,
                {
                  baseName: partBaseName,
                  text: partText,
                  outputDir: runtimeConfig.outputDir,
                  runUiExclusive: (fn) => this.uiLocks.runExclusive(runtimeConfig.cdpUrl, fn),
                },
                wLogger,
                () => this.stopRequested
              );

              savedAudioPath = result.savedPath;
              wLogger.success(
                `${partPrefix} [${currentModel}] -> lưu OK: ${path.basename(result.savedPath)} (${formatSize(result.sizeBytes)})`
              );
              break;
            } catch (err) {
              lastError = err;
              if (this.stopRequested) break;

              const isAccountVerify = Boolean(err && err.isAccountVerify);
              const isQuota = Boolean(err && err.isQuota);
              wLogger.error(
                `${partPrefix} [${currentModel}] -> lỗi (${attempt}/${maxAttempts}): ${err.message}`
              );

              if (isAccountVerify) {
                wLogger.error(
                  `Tài khoản tại ${runtimeConfig.cdpUrl} yêu cầu xác minh: https://aistudio.google.com/verify-account`
                );
                if (
                  settings.rotateProfileOnLimit &&
                  profileSwitches < maxProfileSwitches &&
                  (await tryRotateToAnotherProfile('yêu cầu xác minh tài khoản'))
                ) {
                  profileSwitches += 1;
                  triedModelsForPart.clear();
                  triedModelsForPart.add(currentModel);
                  modelSwitches = 0;
                  attempt -= 1;
                  await this._interruptibleSleep(1500);
                  continue;
                }
                if (runtimeConfig.stopOnAccountVerifyError) {
                  stopWorkerFatal = true;
                }
                break;
              }

              if (
                isQuota &&
                runtimeConfig.rotateModelOnQuotaError &&
                runtimeConfig.ttsModels.length > 1
              ) {
                const cooldownMap = this._getCooldownMap(runtimeConfig.cdpUrl);
                cooldownMap.set(currentModel, Date.now() + runtimeConfig.modelCooldownMs);
                this._emitState();

                const nextModel = this._pickNextModel(
                  currentModel,
                  triedModelsForPart,
                  runtimeConfig.ttsModels,
                  runtimeConfig.cdpUrl,
                  workerId
                );

                if (nextModel && modelSwitches < runtimeConfig.ttsModels.length) {
                  this._updateWorker(workerId, {
                    phase: 'switching_model',
                    lastMessage: `Quota "${currentModel}" -> đổi sang "${nextModel}"`,
                  });

                  try {
                    await this.uiLocks.runExclusive(runtimeConfig.cdpUrl, async () => {
                      await switchTtsModel(page, nextModel, runtimeConfig, wLogger);
                      if (effectiveVoice) {
                        await ensureVoiceSelected(page, effectiveVoice, runtimeConfig, wLogger);
                      }
                      if (effectiveStyle) {
                        await ensureStyleSelected(page, effectiveStyle, runtimeConfig, wLogger);
                      }
                      if (effectiveScene) {
                        await ensureSceneFilled(page, effectiveScene, runtimeConfig, wLogger);
                      }
                    });
                    currentModel = nextModel;
                    triedModelsForPart.add(nextModel);
                    modelSwitches += 1;
                    attempt -= 1;
                    this._updateWorker(workerId, {
                      currentModel,
                      phase: 'generating',
                    });
                    await this._interruptibleSleep(1500);
                    continue;
                  } catch (switchErr) {
                    wLogger.error(`Lỗi đổi model "${nextModel}": ${switchErr.message}`);
                  }
                } else if (
                  settings.rotateProfileOnLimit &&
                  profileSwitches < maxProfileSwitches &&
                  (await tryRotateToAnotherProfile('hết quota tất cả các model'))
                ) {
                  // All models on current Chrome profile exhausted -> rotate to another Chrome profile!
                  profileSwitches += 1;
                  triedModelsForPart.clear();
                  triedModelsForPart.add(currentModel);
                  modelSwitches = 0;
                  attempt -= 1;
                  await this._interruptibleSleep(1500);
                  continue;
                }
              } else if (
                isQuota &&
                settings.rotateProfileOnLimit &&
                profileSwitches < maxProfileSwitches &&
                (await tryRotateToAnotherProfile('đạt giới hạn quota'))
              ) {
                profileSwitches += 1;
                triedModelsForPart.clear();
                triedModelsForPart.add(currentModel);
                modelSwitches = 0;
                attempt -= 1;
                await this._interruptibleSleep(1500);
                continue;
              }

              if (attempt < maxAttempts) {
                const waitMs = isQuota
                  ? runtimeConfig.rateLimitCooldownMs
                  : runtimeConfig.retryBackoffMs[attempt - 1] || 30000;

                this._updateWorker(workerId, {
                  phase: 'cooldown',
                  lastMessage: `Tạm nghỉ ${Math.round(waitMs / 1000)}s trước khi thử lại...`,
                });
                await this._interruptibleSleep(waitMs);

                if (
                  isQuota &&
                  runtimeConfig.rotateModelOnQuotaError &&
                  runtimeConfig.ttsModels.length > 1 &&
                  !this.stopRequested
                ) {
                  const candidate = this._pickLeastCooledModel(
                    runtimeConfig.ttsModels,
                    runtimeConfig.cdpUrl
                  );
                  if (candidate && candidate !== currentModel) {
                    try {
                      await this.uiLocks.runExclusive(runtimeConfig.cdpUrl, async () => {
                        await switchTtsModel(page, candidate, runtimeConfig, wLogger);
                        if (effectiveVoice) {
                          await ensureVoiceSelected(page, effectiveVoice, runtimeConfig, wLogger);
                        }
                        if (effectiveStyle) {
                          await ensureStyleSelected(page, effectiveStyle, runtimeConfig, wLogger);
                        }
                        if (effectiveScene) {
                          await ensureSceneFilled(page, effectiveScene, runtimeConfig, wLogger);
                        }
                      });
                      currentModel = candidate;
                      this._updateWorker(workerId, { currentModel });
                    } catch {
                      // Keep currentModel
                    }
                  }
                }
              } else if (isQuota && runtimeConfig.stopOnQuotaError) {
                stopWorkerFatal = true;
              }
            }
          }

          if (savedAudioPath && !this.stopRequested) {
            this.stats.partsSucceeded += 1;
            chapterPartAudios.push({
              baseName: partBaseName,
              fileName: path.basename(savedAudioPath),
              fullPath: savedAudioPath,
            });
            this._emitState();
          } else if (!savedAudioPath && !this.stopRequested) {
            fileHasFailure = true;
            fileLastError = `Phần ${partNum}: ${lastError ? lastError.message : 'Unknown error'}`;
          }

          if (stopWorkerFatal) break;

          if (pIdx < parts.length - 1 && !this.stopRequested) {
            const delayMs = randomBetween(runtimeConfig.minDelayMs, runtimeConfig.maxDelayMs);
            this._updateWorker(workerId, {
              lastMessage: `Nghỉ ${(delayMs / 1000).toFixed(1)}s trước phần ${partNum + 1}...`,
            });
            await this._interruptibleSleep(delayMs);
          }
        }

        // Phase B: CMS Auto-Publish serialized via CMS Publish Queue Lock!
        if (
          !fileHasFailure &&
          !this.stopRequested &&
          runtimeConfig.publish.enabled &&
          chapterPartAudios.length === parts.length
        ) {
          const toPublish = settings.forceRerun
            ? chapterPartAudios
            : chapterPartAudios.filter(
                (item) => !isFilePublished(runtimeConfig.logsDir, item.baseName)
              );

          if (toPublish.length > 0) {
            const cmsKey = normalizeUrlBase(runtimeConfig.publish.chaptersUrl);
            if (this.cmsLocks.isLocked(cmsKey)) {
              this._updateWorker(workerId, {
                phase: 'waiting_cms',
                lastMessage: 'Đang chờ hàng đợi khóa CMS (tác vụ kia đang đăng)...',
              });
              wLogger.info(`${filePrefix} -> chờ hàng đợi CMS Publish Queue...`);
            }

            try {
              await this.cmsLocks.runExclusive(cmsKey, async () => {
                if (this.stopRequested) return;
                this._updateWorker(workerId, {
                  phase: 'publishing',
                  lastMessage: `Đang ghép & đăng ${toPublish.length} phần lên CMS...`,
                });

                await publishAudioToCms(
                  browser,
                  page,
                  runtimeConfig,
                  toPublish.map((item) => item.fullPath),
                  wLogger,
                  () => this.stopRequested,
                  {
                    expectedChaptersAdded: runtimeConfig.publish.autoMerge ? 1 : toPublish.length,
                  }
                );

                for (const item of toPublish) {
                  recordPublishedFile(runtimeConfig.logsDir, {
                    baseName: item.baseName,
                    chapterBaseName: file.baseName,
                    audioFileName: item.fileName,
                    publishUrl: runtimeConfig.publish.chaptersUrl,
                  });
                }

                // Also record parent chapter completion marker for safe resume after .wav cleanup
                recordPublishedFile(runtimeConfig.logsDir, {
                  baseName: file.baseName,
                  chapterBaseName: file.baseName,
                  audioFileName: `${file.baseName} (${parts.length} parts)`,
                  publishUrl: runtimeConfig.publish.chaptersUrl,
                });

                this.stats.publishedChapters += 1;

                if (runtimeConfig.cleanupAudioAfterPublish) {
                  cleanupAudioFiles(
                    chapterPartAudios.map((item) => item.fullPath),
                    wLogger
                  );
                }
              });
            } catch (pubErr) {
              wLogger.error(`${filePrefix} -> đăng CMS thất bại: ${pubErr.message}`);
              fileHasFailure = true;
              fileLastError = `Publish error: ${pubErr.message}`;
            }
          }
        }

        // Update chapter stats & ETA
        if (!this.stopRequested) {
          if (fileHasFailure) {
            recordFailedFile(runtimeConfig.logsDir, file.fileName, fileLastError || 'Failed');
            this.stats.failedChapters += 1;
            this._updateWorker(workerId, {
              chaptersFailed: this.workersState[workerId - 1].chaptersFailed + 1,
              lastMessage: `Lỗi ở ${file.fileName}`,
            });
          } else {
            clearFailedFile(runtimeConfig.logsDir, file.fileName);
            this.stats.completedChapters += 1;
            this.chapterDurationsMs.push(Date.now() - chapterStartedAt);
            if (this.chapterDurationsMs.length > 20) this.chapterDurationsMs.shift();
            this._recomputeEta(activeWorkersCount);

            this._updateWorker(workerId, {
              chaptersDone: this.workersState[workerId - 1].chaptersDone + 1,
              lastMessage: `Hoàn tất ${file.fileName}`,
            });
          }
        }

        if (stopWorkerFatal) {
          wLogger.error('Dừng tác vụ này do lỗi nghiêm trọng (cần xác minh hoặc dừng khi hết quota).');
          break;
        }

        // Per-chapter model rotation + inter-chapter delay
        const hasMoreInQueue =
          queue.length > 0 &&
          (limitTotal === null || sharedClaimedCounter.processed < limitTotal);

        if (hasMoreInQueue && !this.stopRequested) {
          if (runtimeConfig.rotateModelPerChapter && runtimeConfig.ttsModels.length > 1) {
            const nextModel =
              this._pickNextModel(
                currentModel,
                new Set([currentModel]),
                runtimeConfig.ttsModels,
                runtimeConfig.cdpUrl,
                workerId
              ) ||
              runtimeConfig.ttsModels[
                (Math.max(0, runtimeConfig.ttsModels.indexOf(currentModel)) + 1) %
                  runtimeConfig.ttsModels.length
              ];

            if (nextModel && nextModel !== currentModel) {
              this._updateWorker(workerId, {
                phase: 'switching_model',
                lastMessage: `Đổi model sau chương: ${currentModel} -> ${nextModel}`,
              });
              try {
                await this.uiLocks.runExclusive(runtimeConfig.cdpUrl, async () => {
                  await switchTtsModel(page, nextModel, runtimeConfig, wLogger);
                  if (effectiveVoice) {
                    await ensureVoiceSelected(page, effectiveVoice, runtimeConfig, wLogger);
                  }
                  if (effectiveStyle) {
                    await ensureStyleSelected(page, effectiveStyle, runtimeConfig, wLogger);
                  }
                  if (effectiveScene) {
                    await ensureSceneFilled(page, effectiveScene, runtimeConfig, wLogger);
                  }
                });
                currentModel = nextModel;
                this._updateWorker(workerId, { currentModel });
              } catch (swErr) {
                wLogger.warn(`Không đổi được sang "${nextModel}": ${swErr.message}`);
              }
            }
          }

          const delayMs = randomBetween(runtimeConfig.minDelayMs, runtimeConfig.maxDelayMs);
          this._updateWorker(workerId, {
            phase: 'idle',
            lastMessage: `Nghỉ ${(delayMs / 1000).toFixed(1)}s trước chương tiếp theo...`,
          });
          await this._interruptibleSleep(delayMs);
        }
      }
    } finally {
      await release();
      this._updateWorker(workerId, {
        active: false,
        phase: this.stopRequested ? 'stopped' : 'done',
        currentPart: 0,
        totalParts: 0,
        partStartedAt: null,
        lastMessage: this.stopRequested ? 'Đã dừng an toàn' : 'Hoàn thành nhiệm vụ',
      });
    }
  }
}

module.exports = new AutomationEngine();
