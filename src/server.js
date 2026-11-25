#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const baseConfig = require('../config');
const engine = require('./engine');
const { KNOWN_VOICES, KNOWN_STYLES, loadSettings, saveSettings } = require('./settingsStore');
const { checkCdpEndpoint, launchChromeDebugInstance } = require('./browser');
const { getInputFiles, ensureDirectories } = require('./fileManager');

const PORT = Number(process.env.UI_PORT || 3456);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`JSON không hợp lệ: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function openLocalFolder(folderPath) {
  const resolved = path.resolve(folderPath);
  fs.mkdirSync(resolved, { recursive: true });
  if (process.platform === 'win32') {
    spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [resolved], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [resolved], { detached: true, stdio: 'ignore' }).unref();
  }
}

function openBrowserUrl(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function getFolderSummary(settings) {
  const w1 = settings.workers[0] || {};
  const w2 = settings.workers[1] || {};
  const in1 = path.resolve(w1.inputDir || baseConfig.inputDir);
  const in2 = path.resolve(w2.inputDir || baseConfig.inputDir);

  const count1 = getInputFiles(in1).length;
  const count2 = in1 === in2 ? count1 : getInputFiles(in2).length;

  const profileUrls = (settings.chromeProfiles || []).map((p) => `http://127.0.0.1:${p.port}`);
  const cdpUrls = Array.from(
    new Set([
      ...profileUrls,
      w1.cdpUrl || 'http://127.0.0.1:9222',
      w2.cdpUrl || 'http://127.0.0.1:9223',
    ])
  );

  const cdpChecks = await Promise.all(cdpUrls.map((u) => checkCdpEndpoint(u)));
  const cdpStatus = {};
  for (const item of cdpChecks) {
    cdpStatus[item.cdpUrl] = item;
  }

  return {
    inputCounts: { worker1: count1, worker2: count2 },
    cdpStatus,
  };
}

// Connected SSE clients
const sseClients = new Set();

function broadcastSse(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
}

engine.on('state', (snapshot) => broadcastSse('state', snapshot));
engine.on('log', (entry) => broadcastSse('log', entry));

// Periodic heartbeat so model cooldown countdowns update smoothly on UI
setInterval(() => {
  if (sseClients.size > 0) {
    broadcastSse('state', engine.getSnapshot());
  }
}, 3000).unref();

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

    // SSE stream
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(engine.getSnapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // Bootstrap / state
    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      const settings = loadSettings(baseConfig.logsDir);
      const summary = await getFolderSummary(settings);
      return sendJson(res, 200, {
        settings,
        knownVoices: KNOWN_VOICES,
        knownStyles: KNOWN_STYLES,
        state: engine.getSnapshot(),
        logs: engine.recentLogs,
        summary,
      });
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      const settings = loadSettings(baseConfig.logsDir);
      const summary = await getFolderSummary(settings);
      return sendJson(res, 200, {
        state: engine.getSnapshot(),
        summary,
      });
    }

    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readJsonBody(req);
      const saved = saveSettings(body, baseConfig.logsDir);
      const summary = await getFolderSummary(saved);
      broadcastSse('state', engine.getSnapshot());
      return sendJson(res, 200, { ok: true, settings: saved, summary });
    }

    if (req.method === 'POST' && pathname === '/api/start') {
      const body = await readJsonBody(req);
      if (body.settings && typeof body.settings === 'object') {
        saveSettings(body.settings, baseConfig.logsDir);
      }
      const mode = body.mode || 'batch';
      const state = await engine.start(mode);
      return sendJson(res, 200, { ok: true, state });
    }

    if (req.method === 'POST' && pathname === '/api/stop') {
      const stopped = engine.stop();
      return sendJson(res, 200, { ok: true, stopped, state: engine.getSnapshot() });
    }

    if (req.method === 'POST' && pathname === '/api/logs/clear') {
      engine.clearLogs();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/chrome/launch') {
      const body = await readJsonBody(req);
      const settings = loadSettings(baseConfig.logsDir);
      const profiles = settings.chromeProfiles || [];

      let targetProfile = null;
      if (body.profileId) {
        targetProfile = profiles.find((p) => p.id === body.profileId);
      } else if (body.port) {
        targetProfile = profiles.find((p) => Number(p.port) === Number(body.port));
      }

      const port = Number(targetProfile?.port || body.port || 9222);
      const dirName = targetProfile?.dirName || body.dirName || '';
      const label = targetProfile?.name || `Port ${port}`;
      const model =
        body.model || settings.enabledModels[0] || 'gemini-3.8-flash-tts';

      const info = launchChromeDebugInstance({ port, dirName, model });
      engine.rootLogger.info(
        `Đã mở hồ sơ Chrome "${label}" tại cổng ${port} (${info.profileDir})`
      );
      return sendJson(res, 200, { ok: true, info });
    }

    if (req.method === 'POST' && pathname === '/api/profiles/add') {
      const body = await readJsonBody(req);
      const settings = loadSettings(baseConfig.logsDir);
      const profiles = [...(settings.chromeProfiles || [])];

      const port = Number.parseInt(body.port, 10);
      if (!Number.isFinite(port) || port < 1024 || port > 65535) {
        return sendJson(res, 400, { ok: false, error: 'Cổng Debug phải là số nguyên từ 1024 đến 65535.' });
      }
      if (profiles.some((p) => Number(p.port) === port)) {
        return sendJson(res, 400, { ok: false, error: `Cổng ${port} đã tồn tại trong danh sách hồ sơ.` });
      }

      const name = String(body.name || `Profile ${port}`).trim();
      const newProfile = {
        id: `profile-${port}-${Date.now().toString(36)}`,
        name,
        port,
        dirName: `aistudio-tts-chrome-profile-${port}`,
      };
      profiles.push(newProfile);

      const saved = saveSettings({ chromeProfiles: profiles }, baseConfig.logsDir);
      const summary = await getFolderSummary(saved);
      engine.rootLogger.info(`Đã tạo hồ sơ Chrome mới: "${name}" (cổng ${port})`);
      return sendJson(res, 200, { ok: true, profile: newProfile, settings: saved, summary });
    }

    if (req.method === 'POST' && pathname === '/api/profiles/delete') {
      const body = await readJsonBody(req);
      const settings = loadSettings(baseConfig.logsDir);
      const profiles = [...(settings.chromeProfiles || [])];
      if (profiles.length <= 1) {
        return sendJson(res, 400, { ok: false, error: 'Phải giữ lại ít nhất 1 hồ sơ Chrome.' });
      }
      const nextProfiles = profiles.filter((p) => p.id !== body.id);
      const saved = saveSettings({ chromeProfiles: nextProfiles }, baseConfig.logsDir);
      const summary = await getFolderSummary(saved);
      return sendJson(res, 200, { ok: true, settings: saved, summary });
    }

    if (req.method === 'POST' && pathname === '/api/profiles/reset-cooldown') {
      const body = await readJsonBody(req);
      engine.resetProfileCooldown(body.cdpUrl || null);
      engine.rootLogger.info(
        body.cdpUrl
          ? `Đã gỡ Cooldown cho hồ sơ ${body.cdpUrl}.`
          : 'Đã gỡ Cooldown cho toàn bộ hồ sơ Chrome.'
      );
      return sendJson(res, 200, { ok: true, state: engine.getSnapshot() });
    }

    if (req.method === 'POST' && pathname === '/api/open-folder') {
      const body = await readJsonBody(req);
      const settings = loadSettings(baseConfig.logsDir);
      const w1 = settings.workers[0] || {};
      let targetDir = baseConfig.inputDir;
      if (body.target === 'output') targetDir = w1.outputDir || baseConfig.outputDir;
      else if (body.target === 'logs') targetDir = baseConfig.logsDir;
      else if (body.customPath) targetDir = body.customPath;
      else targetDir = w1.inputDir || baseConfig.inputDir;

      openLocalFolder(targetDir);
      return sendJson(res, 200, { ok: true, path: path.resolve(targetDir) });
    }

    // Static files from public/
    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const safePath = path.normalize(path.join(PUBLIC_DIR, relPath));
    if (!safePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(safePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

ensureDirectories([baseConfig.inputDir, baseConfig.outputDir, baseConfig.logsDir]);

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n======================================================`);
  console.log(`  AI Studio TTS Smart Dashboard đang chạy tại:`);
  console.log(`  👉 ${url}`);
  console.log(`======================================================\n`);

  if (!process.argv.includes('--no-open')) {
    openBrowserUrl(url);
  }
});
