const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env'), quiet: true });

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

const ROOT_DIR = __dirname;

module.exports = {
  // CDP & Target Page
  cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222',
  targetUrlPattern: process.env.TARGET_URL_PATTERN || 'aistudio.google.com/generate-speech',
  fallbackUrlPattern: 'aistudio.google.com',

  // Danh sách model TTS theo thứ tự ưu tiên (tự động xoay vòng khi gặp giới hạn/quota)
  ttsModels: [
    'gemini-3.8-flash-tts',
    'gemini-3.8-flash-lite-tts',
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-pro-preview-tts',
    'gemini-2.5-flash-preview-tts',
  ],
  defaultVoice: process.env.TTS_VOICE || 'Nika',
  defaultStyle: process.env.TTS_STYLE || 'Podcast',
  defaultScene:
    process.env.TTS_SCENE ||
    'A cinematic audiobook narration. The narrator has a clear, resonant, and expressive storytelling voice, smoothly shifting from calm description to dynamic, intense energy during action scenes.',
  rotateModelOnQuotaError: envBool('ROTATE_MODEL_ON_QUOTA_ERROR', true),
  rotateModelPerChapter: envBool('ROTATE_MODEL_PER_CHAPTER', true), // Tự động đổi sang model kế tiếp sau mỗi chương
  modelCooldownMs: envInt('MODEL_COOLDOWN_MS', 300000), // 5 phút tạm nghỉ cho model vừa bị giới hạn

  // Directories
  inputDir: path.resolve(ROOT_DIR, 'input'),
  outputDir: path.resolve(ROOT_DIR, 'output'),
  logsDir: path.resolve(ROOT_DIR, 'logs'),

  // Timings & Retries
  maxWaitAudioMs: envInt('MAX_WAIT_AUDIO_MS', 600000), // 10 minutes
  pollIntervalMs: envInt('POLL_INTERVAL_MS', 2000), // 2 seconds
  runStartTimeoutMs: envInt('RUN_START_TIMEOUT_MS', 15000), // 15 seconds
  downloadTimeoutMs: envInt('DOWNLOAD_TIMEOUT_MS', 60000), // 60 seconds
  minDelayMs: envInt('MIN_DELAY_MS', 3000), // 3 seconds
  maxDelayMs: envInt('MAX_DELAY_MS', 7000), // 7 seconds
  maxRetries: envInt('MAX_RETRIES', 2),
  retryBackoffMs: [15000, 45000],
  rateLimitCooldownMs: envInt('RATE_LIMIT_COOLDOWN_MS', 60000), // 60 seconds
  stopOnQuotaError: envBool('STOP_ON_QUOTA_ERROR', false),
  stopOnAccountVerifyError: envBool('STOP_ON_ACCOUNT_VERIFY_ERROR', true),

  // Download & Validation
  enableNetworkIntercept: envBool('ENABLE_NETWORK_INTERCEPT', false),
  minAudioSizeBytes: 1024, // 1 KB minimum valid audio file
  supportedAudioExtensions: ['.wav', '.mp3', '.ogg', '.m4a'],

  // Chia nhỏ file .txt thành nhiều phần để giảm tải render trên AI Studio
  splitParts: envInt('SPLIT_PARTS', 10), // Mặc định chia 10 phần (đặt 1 để tắt)
  minCharsPerSplit: envInt('MIN_CHARS_PER_SPLIT', 300), // Không chia vụn nếu file quá ngắn

  // CMS Auto-Publish (sau khi tải xong trọn bộ 1 chương)
  publish: {
    enabled: envBool('PUBLISH_ENABLED', true),
    chaptersUrl:
      process.env.PUBLISH_URL ||
      'https://pnttaudio.netlify.app/admin/stories/59a33778-f5e0-4937-b3e8-b5ee46542872/chapters',
    maxWaitUploadMs: envInt('MAX_WAIT_UPLOAD_MS', 300000), // 5 phút (ghép phần + nén WAV -> M4A + upload R2)
    pollIntervalMs: 2000,
    autoMerge: envBool('PUBLISH_AUTO_MERGE', true), // Tự động ghép các phần _1, _2, ... thành 1 chương
    mergeGap: process.env.PUBLISH_MERGE_GAP || '0.4', // '0' | '0.4' | '0.8'
    aacBitrate: process.env.PUBLISH_AAC_BITRATE || '48k', // '48k' | '64k' | '96k' | '128k'
    selectors: {
      bulkUploadTab: [
        'button[role="tab"]:has-text("Nhập chương / Upload")',
        'button[role="tab"]:has-text("Nhập chương")',
        'main button:has-text("Nhập chương / Upload")',
        'main button:has-text("Tải lên hàng loạt")',
        'button:has-text("Bulk Upload")',
      ],
      chaptersListTab: [
        'button[role="tab"]:has-text("Danh sách chương")',
        'main button:has-text("Danh sách chương")',
        'button:has-text("Danh sách chương")',
      ],
      autoMergeCheckbox: [
        'main label:has-text("Tự động nhận diện & ghép") input[type="checkbox"]',
        'div[role="tabpanel"] input[type="checkbox"]',
      ],
      mergeGapSelect: [
        '#merge-gap-select',
      ],
      aacBitrateSelect: [
        '#aac-bitrate-select',
      ],
      fileInput: [
        'div[role="tabpanel"] input[type="file"]',
        'main input[type="file"]',
        'input[type="file"]',
      ],
      uploadSubmitButton: [
        'main button:has-text("Bắt đầu (")',
        'main button:has-text("Bắt đầu")',
        'main button:has-text("Tải lên tất cả")',
        'main button:has-text("Tải lên ngay")',
        'main button:has-text("Đăng tất cả")',
        'main button:has-text("Đăng chương")',
        'main button:has-text("Lưu chương")',
        'main button[type="submit"]',
        'main button:has-text("Tải lên"):not(:has-text("hàng loạt")):not(:has-text("Bulk Upload")):not(:has-text("Nhập chương"))',
        'main button:has-text("Upload"):not(:has-text("hàng loạt")):not(:has-text("Bulk Upload")):not(:has-text("Nhập chương"))',
      ],
      clearQueueButton: [
        'main button:has-text("Xóa danh sách")',
        'main button:has-text("Xóa tất cả")',
        'main button:has-text("Làm mới")',
      ],
    },
  },

  // UI Error & Rate-limit Detection Keywords (case-insensitive)
  errorKeywords: [
    'verify your account',
    'must be verified',
    'verify-account',
    'audio stream could not be completed',
    'please retry your request',
    'quota',
    'rate limit',
    'too many requests',
    'resource exhausted',
    'error',
    'failed',
    'too long',
    'something went wrong',
    'unable to generate',
    'exceeded',
    'internal error',
  ],
  accountVerifyKeywords: [
    'verify your account',
    'must be verified',
    'verify-account',
  ],
  rateLimitKeywords: [
    'quota',
    'rate limit',
    'too many requests',
    'resource exhausted',
    'exceeded',
    'limit reached',
    'daily limit',
    'usage limit',
    '429',
    'try again later',
    'overloaded',
  ],

  // Fallback Selectors (ordered from most specific to most general)
  selectors: {
    // Màn hình khởi tạo Zero-State (xuất hiện khi mở mới hoặc đổi model)
    zeroStateContainer: [
      'ms-speech-zero-state[data-testid="tts-zero-state"]',
      'ms-speech-zero-state',
    ],
    createNewDialogCard: [
      'mat-card[data-testid="create-new-dialog-card"]',
      '[data-testid="create-new-dialog-card"]',
      'mat-card.create-dialog-card',
      'ms-speech-zero-state [role="button"]:has-text("Create new dialog")',
      'ms-speech-zero-state button:has-text("Create new dialog")',
    ],

    // Model selector (đổi model trực tiếp trong sidebar để hạn chế văng về Zero-State)
    modelNameLabel: [
      'ms-model-selector span[data-test-id="model-name"]',
      'span[data-test-id="model-name"]',
    ],
    runSettingsToggle: [
      'button[aria-label="Toggle run settings panel"]',
      'button.runsettings-toggle-button',
    ],
    modelSelectorCard: [
      'ms-model-selector button.model-selector-card',
      'button.model-selector-card',
    ],

    // Chọn giọng đọc & phong cách cố định (Voice & Style selection)
    voiceChipButton: [
      'ms-speech-block button.voice-chip',
      'ms-speech-block button:has-text("Speaker 1")',
      'button.voice-playground-chip',
      'ms-voice-settings button.active-voice-card-trigger',
      'button[aria-label="Open voice settings"]',
    ],
    voiceSearchInput: [
      'ms-speaker-settings-panel input[placeholder="Search voices"]',
      'input[aria-label="Search voices"]',
      'input[placeholder*="Search voices" i]',
    ],
    styleDropdownButton: [
      'ms-speech-block ms-voice-style-dropdown button',
      'ms-speech-block button[aria-label*="Style" i]',
      'ms-speech-block button[aria-haspopup="menu"]:not(.voice-chip):not(:has-text("Speaker")):not(:has-text("Expression"))',
      'ms-speech-block button[aria-haspopup="listbox"]:not(.voice-chip):not(:has-text("Speaker")):not(:has-text("Expression"))',
      'ms-speech-block mat-select',
      'ms-voice-style-dropdown button[aria-label="Style"]',
    ],
    sceneInput: [
      'ms-autosize-textarea[arialabel="Scene"] textarea',
      'textarea[aria-label="Scene"]',
      'textarea[placeholder*="bustling street" i]',
    ],

    promptInput: [
      // Composer mode (3.1 / 3.8 / 2.5) — tránh nhầm ô Scene & Sample Context
      'ms-speech-block textarea[aria-label="Speech block text"]',
      'ms-autosize-textarea.text-block textarea',
      'div.speech-block-card textarea',
      'ms-speech-block textarea',
      // Text mode (Transcript)
      '.transcript-text textarea[aria-label="Enter a prompt"]',
      'div.text-mode-container .transcript-text textarea',
      // Placeholder fallbacks (3.8 dùng '<', 3.1 dùng '[')
      'textarea[placeholder*="Type \'<\' for tags"]',
      'textarea[placeholder*="Type \'[\' for tags"]',
      'textarea[placeholder*="Type \'<\'"]',
      'textarea[placeholder*="Type \'[\'"]',
      'textarea[placeholder*="gasp"]',
      'textarea[placeholder*="amused"]',
      // Generic safe fallbacks (tuyệt đối loại trừ Scene & Sample Context)
      'ms-tts-prompt-input textarea',
      'main textarea:not([aria-label="Scene"]):not([aria-label="Sample Context"])',
      'textarea:not([aria-label="Scene"]):not([aria-label="Sample Context"])',
    ],

    runButton: [
      'ms-audio-footer ms-run-button button',
      'ms-run-button button',
      'button[aria-label="Run"]',
      'button[aria-label^="Run "]',
      'run-button button',
      'button.run-button',
      '[data-test-id="run-button"]',
      'button:has-text("Run"):has-text("Ctrl")',
      'button:has-text("Run"):has-text("Cmd")',
      'button:has-text("Run")',
    ],

    stopButton: [
      'button[aria-label="Stop"]',
      'button[aria-label^="Stop "]',
      'button[aria-label*="Cancel" i]',
      'run-button button:has-text("Stop")',
      'ms-run-button button:has-text("Stop")',
      'button:has-text("Stop")',
      'mat-spinner',
      'mat-progress-spinner',
      '[role="progressbar"]',
      '.generating-spinner',
    ],

    downloadButton: [
      'button[aria-label="Download"]',
      'button[aria-label*="Download" i]',
      'a[aria-label*="Download" i]',
      'button[mattooltip*="Download" i]',
      'button:has(mat-icon:text-is("download"))',
      'button:has(span.material-symbols-outlined:text-is("download"))',
      'button:has(span.material-icons:text-is("download"))',
      'button:has(span.google-symbols:text-is("download"))',
      'a[download]',
    ],

    audioElement: [
      'audio[src]',
      'ms-audio-player audio',
      'audio',
    ],

    durationLabel: [
      'ms-audio-player [class*="duration"]',
      'ms-audio-player [class*="time"]',
      '[class*="audio-bar"] [class*="time"]',
      '[class*="audio-bar"] [class*="duration"]',
      '[class*="audio-player"] [class*="time"]',
      '[class*="audio-player"] [class*="duration"]',
      '.audio-duration',
    ],

    errorToast: [
      'mat-snack-bar-container',
      '.mat-mdc-snack-bar-container',
      'mat-dialog-container',
      '.cdk-overlay-container [role="alert"]',
      '.cdk-overlay-container [role="dialog"]',
      '[role="alert"]',
      '.error-banner',
      '.error-message',
      '.error-container',
      'ms-error-message',
      '[class*="error"]',
    ],
  },
};
