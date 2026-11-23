#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const baseConfig = require('../config');
const Logger = require('./logger');
const {
  ensureDirectories,
  getInputFiles,
  readTextFile,
  findExistingAudio,
  loadFailedEntries,
  recordFailedFile,
  clearFailedFile,
  isFilePublished,
  recordPublishedFile,
} = require('./fileManager');
const { connectToAIStudio, safeDisconnect, inspectPage } = require('./browser');
const { processSingleFile } = require('./automation');
const { publishAudioToCms } = require('./publisher');

function printHelp() {
  console.log(`
Google AI Studio TTS Batch Automation CLI

Cách sử dụng:
  node src/index.js [options]

Tùy chọn:
  --inspect              Kiểm tra và highlight các selector trên tab AI Studio (KHÔNG bấm Run)
  --limit <N>            Chỉ xử lý tối đa N file (không tính file bỏ qua)
  --force                Chạy lại cả những file đã có trong thư mục output / đã đăng
  --retry-failed         Chỉ chạy lại các file nằm trong logs/failed.json
  --input <dir>          Chỉ định thư mục chứa file .txt đầu vào
  --output <dir>         Chỉ định thư mục lưu file audio đầu ra
  --cdp <url>            Ghi đè CDP URL (mặc định: ${baseConfig.cdpUrl})
  --no-publish           Chỉ tải file audio về output/, KHÔNG tự động đăng lên CMS
  --publish-only         Chỉ đăng các file audio có sẵn trong output/ lên CMS (không chạy TTS)
  --publish-url <url>    Ghi đè URL trang quản trị chương CMS
  -h, --help             Hiển thị hướng dẫn này
`);
}

function parseArgs(argv) {
  const opts = {
    inspect: false,
    limit: null,
    force: false,
    retryFailed: false,
    inputDir: baseConfig.inputDir,
    outputDir: baseConfig.outputDir,
    cdpUrl: baseConfig.cdpUrl,
    publishEnabled: baseConfig.publish.enabled,
    publishOnly: false,
    publishUrl: baseConfig.publish.chaptersUrl,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--inspect':
        opts.inspect = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--retry-failed':
        opts.retryFailed = true;
        break;
      case '--no-publish':
        opts.publishEnabled = false;
        break;
      case '--publish-only':
        opts.publishOnly = true;
        opts.publishEnabled = true;
        break;
      case '--publish-url': {
        const next = argv[++i];
        if (!next) throw new Error('Thiếu URL sau --publish-url.');
        opts.publishUrl = next;
        break;
      }
      case '--limit': {
        const next = argv[++i];
        const parsed = Number.parseInt(next, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Giá trị --limit không hợp lệ: "${next}". Phải là số nguyên dương.`);
        }
        opts.limit = parsed;
        break;
      }
      case '--input': {
        const next = argv[++i];
        if (!next) throw new Error('Thiếu đường dẫn sau --input.');
        opts.inputDir = path.resolve(process.cwd(), next);
        break;
      }
      case '--output': {
        const next = argv[++i];
        if (!next) throw new Error('Thiếu đường dẫn sau --output.');
        opts.outputDir = path.resolve(process.cwd(), next);
        break;
      }
      case '--cdp': {
        const next = argv[++i];
        if (!next) throw new Error('Thiếu URL sau --cdp.');
        opts.cdpUrl = next;
        break;
      }
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`Tham số không hợp lệ: "${arg}". Dùng --help để xem hướng dẫn.`);
    }
  }

  return opts;
}

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

async function interruptibleSleep(ms, shouldStop) {
  const step = 500;
  let remaining = ms;
  while (remaining > 0 && !shouldStop()) {
    await sleep(Math.min(step, remaining));
    remaining -= step;
  }
}

function getOutputAudioFiles(outputDir, supportedExtensions) {
  if (!fs.existsSync(outputDir)) return [];
  const exts = new Set(supportedExtensions.map((e) => e.toLowerCase()));
  return fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((e) => e.isFile() && exts.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((fileName) => {
      const ext = path.extname(fileName);
      const fullPath = path.join(outputDir, fileName);
      const stat = fs.statSync(fullPath);
      return {
        fileName,
        baseName: fileName.slice(0, -ext.length),
        fullPath,
        size: stat.size,
      };
    })
    .filter((f) => f.size > 0);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Lỗi tham số: ${err.message}`);
    process.exit(1);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const config = {
    ...baseConfig,
    inputDir: opts.inputDir,
    outputDir: opts.outputDir,
    cdpUrl: opts.cdpUrl,
    publish: {
      ...baseConfig.publish,
      enabled: opts.publishEnabled,
      chaptersUrl: opts.publishUrl,
    },
  };

  ensureDirectories([config.inputDir, config.outputDir, config.logsDir]);
  const logger = new Logger(config.logsDir);

  let isShuttingDown = false;
  const shouldStop = () => isShuttingDown;

  process.on('SIGINT', () => {
    if (isShuttingDown) {
      logger.warn('Nhận SIGINT lần 2, thoát ngay lập tức.');
      process.exit(130);
    }
    isShuttingDown = true;
    logger.warn('Nhận tín hiệu dừng (Ctrl+C). Đang hoàn tất ghi log và thoát an toàn...');
  });

  // Connect CDP
  let browser;
  let page = null;
  let disconnect;

  if (opts.publishOnly) {
    logger.info(`Chế độ --publish-only: kết nối Chrome CDP tại ${config.cdpUrl} ...`);
    try {
      browser = await chromium.connectOverCDP(config.cdpUrl);
      disconnect = () => safeDisconnect(browser, logger);
    } catch (err) {
      logger.error(`Không thể kết nối Chrome CDP tại ${config.cdpUrl}: ${err.message}`);
      process.exit(1);
    }
  } else {
    try {
      const session = await connectToAIStudio(config, logger);
      browser = session.browser;
      page = session.page;
      disconnect = session.disconnect;
    } catch {
      process.exit(1);
    }
  }

  const stats = {
    total: 0,
    succeeded: 0,
    published: 0,
    skipped: 0,
    failed: 0,
  };

  try {
    if (opts.inspect) {
      await inspectPage(page, config, logger);
      return;
    }

    // Mode: --publish-only (upload existing output/*.wav files to CMS)
    if (opts.publishOnly) {
      const audioFiles = getOutputAudioFiles(config.outputDir, config.supportedAudioExtensions);
      if (audioFiles.length === 0) {
        logger.warn(`Không tìm thấy file audio nào trong: ${config.outputDir}`);
        return;
      }

      stats.total = audioFiles.length;
      logger.info(`Tìm thấy ${audioFiles.length} file audio trong ${config.outputDir}`);

      let processed = 0;
      for (let i = 0; i < audioFiles.length; i++) {
        if (shouldStop()) break;
        if (opts.limit !== null && processed >= opts.limit) {
          logger.info(`Đã đạt giới hạn --limit ${opts.limit}. Dừng.`);
          break;
        }

        const audio = audioFiles[i];
        const prefix = `[${i + 1}/${audioFiles.length}] ${audio.fileName}`;

        if (!opts.force && isFilePublished(config.logsDir, audio.baseName)) {
          logger.skip(`${prefix} -> đã đăng lên CMS trước đó.`);
          stats.skipped += 1;
          continue;
        }

        processed += 1;
        try {
          await publishAudioToCms(browser, null, config, audio.fullPath, logger, shouldStop);
          recordPublishedFile(config.logsDir, {
            baseName: audio.baseName,
            audioFileName: audio.fileName,
            publishUrl: config.publish.chaptersUrl,
          });
          stats.published += 1;
          stats.succeeded += 1;
        } catch (err) {
          logger.error(`${prefix} -> đăng lên CMS thất bại: ${err.message}`);
          recordFailedFile(config.logsDir, `${audio.baseName}.txt`, `Publish error: ${err.message}`);
          stats.failed += 1;
        }
      }
      return;
    }

    // Normal mode: TTS generation (+ optional auto-publish after each file)
    let files = getInputFiles(config.inputDir);

    if (opts.retryFailed) {
      const failedEntries = loadFailedEntries(config.logsDir);
      const failedNames = new Set(failedEntries.map((e) => e.fileName));
      files = files.filter((f) => failedNames.has(f.fileName));
      logger.info(`Chế độ --retry-failed: tìm thấy ${files.length} file lỗi cần chạy lại.`);
    }

    if (files.length === 0) {
      logger.warn(`Không tìm thấy file .txt nào để xử lý trong: ${config.inputDir}`);
      return;
    }

    stats.total = files.length;
    logger.info(
      `Bắt đầu batch: ${files.length} file .txt | Input: ${config.inputDir} | Output: ${config.outputDir}` +
        (config.publish.enabled ? ` | Auto-Publish: ON (${config.publish.chaptersUrl})` : ' | Auto-Publish: OFF')
    );

    let processedCount = 0;

    for (let i = 0; i < files.length; i++) {
      if (shouldStop()) break;
      if (opts.limit !== null && processedCount >= opts.limit) {
        logger.info(`Đã đạt giới hạn --limit ${opts.limit}. Dừng batch.`);
        break;
      }

      const file = files[i];
      const prefix = `[${i + 1}/${files.length}] ${file.fileName}`;

      // 1. Check resume skip
      let existingAudio = null;
      if (!opts.force) {
        existingAudio = findExistingAudio(
          config.outputDir,
          file.baseName,
          config.supportedAudioExtensions
        );
        if (existingAudio) {
          const alreadyPublished = !config.publish.enabled || isFilePublished(config.logsDir, file.baseName);
          if (alreadyPublished) {
            logger.skip(`${prefix} -> đã có ${existingAudio.fileName} (${formatSize(existingAudio.size)})`);
            stats.skipped += 1;
            clearFailedFile(config.logsDir, file.fileName);
            continue;
          }

          // Audio exists on disk, only needs publishing
          processedCount += 1;
          logger.info(
            `${prefix} -> đã có ${existingAudio.fileName}, bỏ qua TTS và tiến hành đăng lên CMS...`
          );
          try {
            await publishAudioToCms(browser, page, config, existingAudio.path, logger, shouldStop);
            recordPublishedFile(config.logsDir, {
              baseName: file.baseName,
              audioFileName: existingAudio.fileName,
              publishUrl: config.publish.chaptersUrl,
            });
            clearFailedFile(config.logsDir, file.fileName);
            stats.published += 1;
            stats.succeeded += 1;
          } catch (pubErr) {
            logger.error(`${prefix} -> đăng lên CMS thất bại: ${pubErr.message}`);
            recordFailedFile(config.logsDir, file.fileName, `Publish error: ${pubErr.message}`);
            stats.failed += 1;
          }
          continue;
        }
      }

      // 2. Read and validate text content
      let text;
      try {
        text = readTextFile(file.fullPath);
      } catch (err) {
        logger.error(`${prefix} -> không đọc được file: ${err.message}`);
        recordFailedFile(config.logsDir, file.fileName, `Read error: ${err.message}`);
        stats.failed += 1;
        continue;
      }

      if (!text) {
        logger.skip(`${prefix} -> file rỗng, bỏ qua.`);
        stats.skipped += 1;
        continue;
      }

      processedCount += 1;
      logger.info(`${prefix} -> bắt đầu xử lý (${text.length} ký tự)...`);

      // 3. Process TTS with retries & rate limit handling
      let savedAudioPath = null;
      let lastError = null;
      let stopBatchDueToQuota = false;
      let stopBatchDueToVerify = false;

      const maxAttempts = config.maxRetries + 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (shouldStop()) break;

        try {
          const result = await processSingleFile(
            page,
            config,
            {
              baseName: file.baseName,
              text,
              outputDir: config.outputDir,
            },
            logger,
            shouldStop
          );

          savedAudioPath = result.savedPath;
          logger.success(
            `${prefix} -> lưu thành công: ${path.basename(result.savedPath)} (${formatSize(result.sizeBytes)})`
          );
          break;
        } catch (err) {
          lastError = err;
          if (shouldStop()) break;

          const isAccountVerify = Boolean(err && err.isAccountVerify);
          const isQuota = Boolean(err && err.isQuota);
          logger.error(`${prefix} -> lỗi (lần ${attempt}/${maxAttempts}): ${err.message}`);

          if (isAccountVerify) {
            logger.error(
              'Google AI Studio yêu cầu xác minh tài khoản tại: https://aistudio.google.com/verify-account'
            );
            if (config.stopOnAccountVerifyError) {
              stopBatchDueToVerify = true;
            }
            break;
          }

          if (attempt < maxAttempts) {
            const waitMs = isQuota
              ? config.rateLimitCooldownMs
              : config.retryBackoffMs[attempt - 1] ||
                config.retryBackoffMs[config.retryBackoffMs.length - 1] ||
                30000;

            logger.warn(
              isQuota
                ? `Phát hiện giới hạn quota/rate limit. Tạm nghỉ ${Math.round(waitMs / 1000)}s trước khi thử lại...`
                : `Chờ ${Math.round(waitMs / 1000)}s trước khi thử lại lần ${attempt + 1}...`
            );
            await interruptibleSleep(waitMs, shouldStop);
          } else if (isQuota && config.stopOnQuotaError) {
            stopBatchDueToQuota = true;
          }
        }
      }

      // 4. Auto-publish to CMS after successful download
      if (savedAudioPath && !shouldStop()) {
        if (config.publish.enabled) {
          try {
            await publishAudioToCms(browser, page, config, savedAudioPath, logger, shouldStop);
            recordPublishedFile(config.logsDir, {
              baseName: file.baseName,
              audioFileName: path.basename(savedAudioPath),
              publishUrl: config.publish.chaptersUrl,
            });
            clearFailedFile(config.logsDir, file.fileName);
            stats.published += 1;
            stats.succeeded += 1;
          } catch (pubErr) {
            logger.error(`${prefix} -> tải audio OK nhưng đăng lên CMS thất bại: ${pubErr.message}`);
            recordFailedFile(config.logsDir, file.fileName, `Publish error: ${pubErr.message}`);
            stats.failed += 1;
          }
        } else {
          clearFailedFile(config.logsDir, file.fileName);
          stats.succeeded += 1;
        }
      } else if (!savedAudioPath && !shouldStop()) {
        const reason = lastError ? lastError.message : 'Unknown error';
        recordFailedFile(config.logsDir, file.fileName, reason);
        stats.failed += 1;
        logger.error(`${prefix} -> THẤT BẠI sau ${maxAttempts} lần thử. Đã ghi vào logs/failed.json.`);
      }

      if (stopBatchDueToVerify) {
        logger.error(
          'Dừng batch ngay lập tức vì tài khoản cần xác minh. Xác minh xong rồi chạy lại `node src/index.js` để tiếp tục.'
        );
        break;
      }

      if (stopBatchDueToQuota) {
        logger.error('Cấu hình stopOnQuotaError=true: dừng toàn bộ batch do lỗi quota.');
        break;
      }

      // 5. Random delay before next file
      const hasMore =
        i < files.length - 1 && (opts.limit === null || processedCount < opts.limit);
      if (hasMore && !shouldStop()) {
        const delayMs = randomBetween(config.minDelayMs, config.maxDelayMs);
        logger.info(`Nghỉ ${(delayMs / 1000).toFixed(1)}s trước khi xử lý file tiếp theo...`);
        await interruptibleSleep(delayMs, shouldStop);
      }
    }
  } finally {
    if (!opts.inspect) {
      logger.info('================ TỔNG KẾT ================');
      logger.info(`Tổng file quét : ${stats.total}`);
      logger.success(`Thành công     : ${stats.succeeded}`);
      if (config.publish.enabled) {
        logger.success(`Đã đăng CMS    : ${stats.published}`);
      }
      logger.skip(`Bỏ qua (skip)  : ${stats.skipped}`);
      if (stats.failed > 0) {
        logger.error(`Thất bại       : ${stats.failed} (xem chi tiết tại logs/failed.json)`);
      } else {
        logger.info(`Thất bại       : 0`);
      }
      logger.info('==========================================');
    }

    await disconnect();
  }
}

main().catch((err) => {
  console.error('Lỗi không mong muốn:', err);
  process.exit(1);
});
