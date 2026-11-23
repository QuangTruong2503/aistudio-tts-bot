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

  // Directories
  inputDir: path.resolve(ROOT_DIR, 'input'),
  outputDir: path.resolve(ROOT_DIR, 'output'),
  logsDir: path.resolve(ROOT_DIR, 'logs'),

  // Timings & Retries
  maxWaitAudioMs: envInt('MAX_WAIT_AUDIO_MS', 600000), // 10 minutes
  pollIntervalMs: envInt('POLL_INTERVAL_MS', 2000), // 2 seconds
  runStartTimeoutMs: envInt('RUN_START_TIMEOUT_MS', 15000), // 15 seconds
  downloadTimeoutMs: envInt('DOWNLOAD_TIMEOUT_MS', 60000), // 60 seconds
  minDelayMs: envInt('MIN_DELAY_MS', 5000), // 5 seconds
  maxDelayMs: envInt('MAX_DELAY_MS', 10000), // 10 seconds
  maxRetries: envInt('MAX_RETRIES', 2),
  retryBackoffMs: [15000, 45000],
  rateLimitCooldownMs: envInt('RATE_LIMIT_COOLDOWN_MS', 60000), // 60 seconds
  stopOnQuotaError: envBool('STOP_ON_QUOTA_ERROR', false),
  stopOnAccountVerifyError: envBool('STOP_ON_ACCOUNT_VERIFY_ERROR', true),

  // Download & Validation
  enableNetworkIntercept: envBool('ENABLE_NETWORK_INTERCEPT', false),
  minAudioSizeBytes: 1024, // 1 KB minimum valid audio file
  supportedAudioExtensions: ['.wav', '.mp3', '.ogg', '.m4a'],

  // CMS Auto-Publish (sau khi tải audio thành công)
  publish: {
    enabled: envBool('PUBLISH_ENABLED', true),
    chaptersUrl:
      process.env.PUBLISH_URL ||
      'https://pnttaudio.netlify.app/admin/stories/59a33778-f5e0-4937-b3e8-b5ee46542872/chapters',
    maxWaitUploadMs: envInt('MAX_WAIT_UPLOAD_MS', 300000), // 5 phút (nén WAV -> M4A + upload R2)
    pollIntervalMs: 2000,
    selectors: {
      bulkUploadTab: [
        'main button:has-text("Tải lên hàng loạt")',
        'button:has-text("Tải lên hàng loạt")',
        'button:has-text("Bulk Upload")',
      ],
      chaptersListTab: [
        'main button:has-text("Danh sách chương")',
        'button:has-text("Danh sách chương")',
      ],
      fileInput: [
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
        'main button:has-text("Tải lên"):not(:has-text("hàng loạt")):not(:has-text("Bulk Upload"))',
        'main button:has-text("Upload"):not(:has-text("hàng loạt")):not(:has-text("Bulk Upload"))',
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
  ],

  // Fallback Selectors (ordered from most specific to most general)
  selectors: {
    promptInput: [
      'textarea[placeholder*="Type \'<\' for tags"]',
      'textarea[placeholder*="Type \'<\'"]',
      'textarea[placeholder*="gasp"]',
      '[contenteditable="true"][aria-placeholder*="Type \'<\'"]',
      '[contenteditable="true"][data-placeholder*="Type \'<\'"]',
      '[contenteditable="true"][placeholder*="Type \'<\'"]',
      'ms-speech-block textarea',
      'ms-speech-block [contenteditable="true"]',
      'ms-tts-prompt-input textarea',
      'ms-tts-prompt-input [contenteditable="true"]',
      'textarea[aria-label*="speech" i]',
      'textarea[aria-label*="text" i]',
      'main textarea',
      'textarea',
    ],

    runButton: [
      'button[aria-label="Run"]',
      'button[aria-label^="Run "]',
      'run-button button',
      'ms-run-button button',
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
    ],
  },
};
