const fs = require('fs');
const path = require('path');
const baseConfig = require('../config');

const KNOWN_VOICES = [
  '', // Giữ nguyên giọng đang chọn trên trình duyệt
  'Nika',
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
];

const KNOWN_STYLES = [
  '', // Giữ nguyên style mặc định trên trình duyệt
  'Podcast',
  'Friendly',
  'Storyteller',
  'Calm',
  'Serious',
  'Cheerful',
  'Newscaster',
  'Whisper',
  'Empathetic',
  'Vocal Smile',
  'Promo/Hype',
  'Deadpan',
];

function getDefaultSettings() {
  const models = Array.isArray(baseConfig.ttsModels)
    ? [...baseConfig.ttsModels]
    : [
        'gemini-3.8-flash-tts',
        'gemini-3.8-flash-lite-tts',
        'gemini-3.1-flash-tts-preview',
        'gemini-2.5-pro-preview-tts',
        'gemini-2.5-flash-preview-tts',
      ];

  return {
    // Chế độ điều phối: 'shared' (gộp sức chạy chung 1 truyện) | 'independent' (2 truyện độc lập)
    queueMode: 'shared',
    workerCount: 2, // 1 hoặc 2 tác vụ song song

    // Danh sách model được phép dùng (theo thứ tự ưu tiên) & toàn bộ model có sẵn
    allModels: models,
    enabledModels: [...models],
    rotateModelOnQuotaError: baseConfig.rotateModelOnQuotaError !== false,
    rotateModelPerChapter: baseConfig.rotateModelPerChapter !== false,
    modelCooldownSec: Math.round((baseConfig.modelCooldownMs || 300000) / 1000),

    // Cấu hình chia văn bản & giọng đọc chung
    splitParts: baseConfig.splitParts || 4,
    minCharsPerSplit: baseConfig.minCharsPerSplit || 300,
    voiceName: baseConfig.defaultVoice || 'Nika', // Mặc định Nika (để rỗng nếu muốn giữ nguyên trình duyệt)
    voiceStyle: baseConfig.defaultStyle || 'Podcast', // Mặc định Podcast
    scenePrompt: baseConfig.defaultScene || '', // Điền tự động vào ô Scene đối với model có trường Scene (VD: 3.1)

    // Cấu hình thời gian & chống lỗi (đơn vị giây để người dùng dễ nhập trên UI)
    maxWaitAudioSec: Math.round((baseConfig.maxWaitAudioMs || 600000) / 1000),
    minDelaySec: Math.round((baseConfig.minDelayMs || 5000) / 1000),
    maxDelaySec: Math.round((baseConfig.maxDelayMs || 10000) / 1000),
    maxRetries: baseConfig.maxRetries ?? 2,
    rateLimitCooldownSec: Math.round((baseConfig.rateLimitCooldownMs || 60000) / 1000),
    stopOnQuotaError: Boolean(baseConfig.stopOnQuotaError),
    stopOnAccountVerifyError: baseConfig.stopOnAccountVerifyError !== false,

    // Cấu hình CMS Auto-Publish & dọn dẹp ổ cứng
    publishEnabled: baseConfig.publish?.enabled !== false,
    autoMerge: baseConfig.publish?.autoMerge !== false,
    mergeGap: baseConfig.publish?.mergeGap || '0.4',
    aacBitrate: baseConfig.publish?.aacBitrate || '48k',
    maxWaitUploadSec: Math.round((baseConfig.publish?.maxWaitUploadMs || 300000) / 1000),
    cleanupAudioAfterPublish: false,

    // Giới hạn chạy & tùy chọn chạy
    limitChapters: 0, // 0 = không giới hạn (chạy hết)
    forceRerun: false,

    // Luân phiên tự động giữa các hồ sơ Chrome khi hồ sơ hiện tại chạm giới hạn / cần xác minh
    rotateProfileOnLimit: true,
    autoLaunchProfileOnRotate: true,
    profileCooldownMin: 30, // Số phút tạm nghỉ cho hồ sơ vừa chạm giới hạn

    // Danh sách hồ sơ Chrome Debug (có thể tạo/xóa không giới hạn)
    chromeProfiles: [
      {
        id: 'profile-1',
        name: 'Profile 1 (Chính)',
        port: 9222,
        dirName: 'aistudio-tts-chrome-profile',
      },
      {
        id: 'profile-2',
        name: 'Profile 2 (Phụ)',
        port: 9223,
        dirName: 'aistudio-tts-chrome-profile-2',
      },
    ],

    // Cấu hình riêng từng Worker (hỗ trợ cả 1 Chrome 2 Tab hoặc nhiều Chrome Profile riêng)
    workers: [
      {
        id: 1,
        name: 'Tác vụ 1',
        cdpUrl: baseConfig.cdpUrl || 'http://127.0.0.1:9222',
        initialModel: models[0] || 'gemini-3.8-flash-tts',
        voiceName: '', // Rỗng = dùng voiceName chung
        inputDir: baseConfig.inputDir,
        outputDir: baseConfig.outputDir,
        publishUrl:
          baseConfig.publish?.chaptersUrl ||
          'http://localhost:5173/admin/stories/59a33778-f5e0-4937-b3e8-b5ee46542872/chapters',
      },
      {
        id: 2,
        name: 'Tác vụ 2',
        cdpUrl: 'http://127.0.0.1:9222', // Người dùng có thể đổi thành http://127.0.0.1:9223 nếu mở Chrome 2
        initialModel: models[1] || models[0] || 'gemini-3.8-flash-lite-tts',
        voiceName: '',
        inputDir: baseConfig.inputDir,
        outputDir: baseConfig.outputDir,
        publishUrl:
          baseConfig.publish?.chaptersUrl ||
          'http://localhost:5173/admin/stories/59a33778-f5e0-4937-b3e8-b5ee46542872/chapters',
      },
    ],
  };
}

function getSettingsPath(logsDir = baseConfig.logsDir) {
  return path.join(logsDir, 'ui-settings.json');
}

function mergeSettings(defaults, saved) {
  if (!saved || typeof saved !== 'object') return defaults;
  const merged = { ...defaults, ...saved };

  // Ensure allModels includes all default models + any user-added custom models
  const modelSet = new Set([
    ...(defaults.allModels || []),
    ...(Array.isArray(saved.allModels) ? saved.allModels : []),
    ...(Array.isArray(saved.enabledModels) ? saved.enabledModels : []),
  ]);
  merged.allModels = Array.from(modelSet).filter(Boolean);

  if (!Array.isArray(merged.enabledModels) || merged.enabledModels.length === 0) {
    merged.enabledModels = [...defaults.enabledModels];
  }

  // Merge chromeProfiles cleanly
  if (Array.isArray(saved.chromeProfiles) && saved.chromeProfiles.length > 0) {
    merged.chromeProfiles = saved.chromeProfiles
      .filter((p) => p && Number.isFinite(Number(p.port)))
      .map((p, idx) => ({
        id: String(p.id || `profile-${p.port}-${idx + 1}`),
        name: String(p.name || `Profile ${p.port}`).trim(),
        port: Number(p.port),
        dirName: String(
          p.dirName ||
            (Number(p.port) === 9222
              ? 'aistudio-tts-chrome-profile'
              : `aistudio-tts-chrome-profile-${p.port}`)
        ),
      }));
  } else {
    merged.chromeProfiles = defaults.chromeProfiles;
  }

  // Merge workers array cleanly (always 2 worker slots)
  const savedWorkers = Array.isArray(saved.workers) ? saved.workers : [];
  merged.workers = defaults.workers.map((defW, idx) => ({
    ...defW,
    ...(savedWorkers[idx] || {}),
    id: idx + 1,
  }));

  return merged;
}

function loadSettings(logsDir = baseConfig.logsDir) {
  const defaults = getDefaultSettings();
  const filePath = getSettingsPath(logsDir);
  if (!fs.existsSync(filePath)) {
    return defaults;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return mergeSettings(defaults, parsed);
  } catch {
    return defaults;
  }
}

function saveSettings(newSettings, logsDir = baseConfig.logsDir) {
  const current = loadSettings(logsDir);
  const merged = mergeSettings(current, newSettings);
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(getSettingsPath(logsDir), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = {
  KNOWN_VOICES,
  KNOWN_STYLES,
  getDefaultSettings,
  loadSettings,
  saveSettings,
};
