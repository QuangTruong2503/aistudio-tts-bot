const PHASE_LABELS = {
  idle: 'Sẵn sàng',
  connecting: 'Đang kết nối CDP',
  generating: 'Đang tạo Audio',
  waiting_cms: 'Chờ hàng đợi CMS',
  publishing: 'Đang ghép & đăng CMS',
  cooldown: 'Đang nghỉ Cooldown',
  switching_model: 'Đang đổi Model',
  stopped: 'Đã dừng',
  done: 'Hoàn tất',
  error: 'Gặp lỗi',
};

let currentSettings = null;
let knownVoices = [];
let knownStyles = [];
let latestState = null;
let latestSummary = null;
let allLogs = [];
let orderedModels = []; // [{ model, enabled }]
let chromeProfiles = []; // [{ id, name, port, dirName }]

const $ = (id) => document.getElementById(id);

function formatDurationSec(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '--';
  if (sec <= 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTimerFromIso(isoStr) {
  if (!isoStr) return '00:00';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000));
  const m = String(Math.floor(diffSec / 60)).padStart(2, '0');
  const s = String(diffSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/* ---------- Settings Form Binding ---------- */

function populateVoiceSelect(voices, selectedVoice) {
  const sel = $('cfgVoiceSelect');
  sel.innerHTML = '';
  const inKnown = voices.includes(selectedVoice);

  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v === '' ? '— Giữ nguyên giọng đang chọn trên trình duyệt —' : v;
    sel.appendChild(opt);
  }

  if (selectedVoice && !inKnown) {
    sel.value = '';
    $('cfgVoiceCustom').value = selectedVoice;
  } else {
    sel.value = selectedVoice || '';
    $('cfgVoiceCustom').value = '';
  }
}

function populateStyleSelect(styles, selectedStyle) {
  const sel = $('cfgStyleSelect');
  sel.innerHTML = '';
  const inKnown = styles.includes(selectedStyle);

  for (const st of styles) {
    const opt = document.createElement('option');
    opt.value = st;
    opt.textContent = st === '' ? '— Giữ nguyên Style mặc định trên trình duyệt —' : st;
    sel.appendChild(opt);
  }

  if (selectedStyle && !inKnown) {
    sel.value = '';
    $('cfgStyleCustom').value = selectedStyle;
  } else {
    sel.value = selectedStyle || '';
    $('cfgStyleCustom').value = '';
  }
}

function populateWorkerProfileDropdowns() {
  const cdpStatus = latestSummary?.cdpStatus || {};
  for (const selId of ['w1CdpUrl', 'w2CdpUrl']) {
    const sel = $(selId);
    const prev = sel.value;
    sel.innerHTML = '';

    for (const p of chromeProfiles) {
      const url = `http://127.0.0.1:${p.port}`;
      const online = cdpStatus[url]?.online;
      const opt = document.createElement('option');
      opt.value = url;
      opt.textContent = `${p.name} (:${p.port}) — ${online ? '🟢 Online' : '⚪ Offline'}`;
      sel.appendChild(opt);
    }

    if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
      sel.value = prev;
    }
  }
}

function getNextSuggestedPort() {
  const used = new Set(chromeProfiles.map((p) => Number(p.port)));
  let port = 9222;
  while (used.has(port)) port += 1;
  return port;
}

function renderChromeProfilesUI() {
  const cdpStatus = latestSummary?.cdpStatus || {};

  // 1. Topbar compact pills
  const topbar = $('topbarProfilesContainer');
  if (topbar) {
    topbar.innerHTML = '';
    for (const p of chromeProfiles) {
      const url = `http://127.0.0.1:${p.port}`;
      const online = Boolean(cdpStatus[url]?.online);
      const pill = document.createElement('div');
      pill.className = 'cdp-pill';
      pill.title = `${p.name} — ${url}`;
      pill.innerHTML = `
        <span class="dot ${online ? 'online' : 'offline'}"></span>
        <span>${p.name} (${p.port})</span>
        <button type="button" class="btn-mini" data-launch-profile="${p.id}">Mở</button>
      `;
      topbar.appendChild(pill);
    }
  }

  // 2. Profiles Manager tab list
  const listEl = $('profilesManagerList');
  if (listEl) {
    listEl.innerHTML = '';
    for (const p of chromeProfiles) {
      const url = `http://127.0.0.1:${p.port}`;
      const online = Boolean(cdpStatus[url]?.online);
      const card = document.createElement('div');
      card.className = 'profile-card';
      card.innerHTML = `
        <div class="profile-info">
          <span class="dot ${online ? 'online' : 'offline'}"></span>
          <div class="profile-meta-text">
            <strong>${p.name}</strong>
            <small>${url} • Thư mục: ${p.dirName}</small>
          </div>
        </div>
        <div class="profile-actions">
          <button type="button" class="btn btn-primary btn-sm" data-launch-profile="${p.id}">▶ Mở Chrome</button>
          <button type="button" class="btn btn-secondary btn-sm" data-assign-w="1" data-url="${url}">Gán W1</button>
          <button type="button" class="btn btn-secondary btn-sm" data-assign-w="2" data-url="${url}">Gán W2</button>
          <button type="button" class="btn btn-danger btn-sm" data-delete-profile="${p.id}" ${chromeProfiles.length <= 1 ? 'disabled' : ''}>Xóa</button>
        </div>
      `;
      listEl.appendChild(card);
    }
  }

  // 3. Suggest next available port in create form
  const portInput = $('newProfilePort');
  if (portInput && !portInput.matches(':focus')) {
    portInput.placeholder = String(getNextSuggestedPort());
  }

  // 4. Sync Worker 1 & Worker 2 profile dropdowns
  populateWorkerProfileDropdowns();
}

function populateWorkerModelDropdowns() {
  const enabled = orderedModels.filter((m) => m.enabled).map((m) => m.model);
  const list = enabled.length > 0 ? enabled : orderedModels.map((m) => m.model);

  for (const selId of ['w1InitialModel', 'w2InitialModel']) {
    const sel = $(selId);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    }
    if (list.includes(prev)) {
      sel.value = prev;
    }
  }
}

function renderModelsList() {
  const container = $('modelsListContainer');
  container.innerHTML = '';
  const healthMap = new Map();
  if (latestState && Array.isArray(latestState.modelsHealth)) {
    for (const h of latestState.modelsHealth) {
      healthMap.set(h.model, h);
    }
  }

  orderedModels.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'model-item';

    const h = healthMap.get(item.model);
    let healthBadge = `<span class="m-health m-ready">Sẵn sàng</span>`;
    if (h) {
      if (h.status === 'cooldown') {
        healthBadge = `<span class="m-health m-cooldown">Cooldown ${h.cooldownRemainingSec}s</span>`;
      } else if (h.status === 'in_use') {
        healthBadge = `<span class="m-health m-in_use">${h.inUseBy.join(', ')}</span>`;
      }
    }

    row.innerHTML = `
      <div class="model-left">
        <span class="model-rank">#${idx + 1}</span>
        <input type="checkbox" class="model-cb" data-idx="${idx}" ${item.enabled ? 'checked' : ''} />
        <span class="model-code">${item.model}</span>
      </div>
      <div class="model-right">
        ${healthBadge}
        <button type="button" class="icon-btn" data-move="up" data-idx="${idx}" title="Tăng ưu tiên">▲</button>
        <button type="button" class="icon-btn" data-move="down" data-idx="${idx}" title="Giảm ưu tiên">▼</button>
      </div>
    `;
    container.appendChild(row);
  });

  populateWorkerModelDropdowns();
}

function applySettingsToForm(s) {
  currentSettings = s;

  // Build orderedModels: enabled first in exact priority order, then disabled ones
  const enabledSet = new Set(s.enabledModels || []);
  orderedModels = [];
  for (const m of s.enabledModels || []) {
    orderedModels.push({ model: m, enabled: true });
  }
  for (const m of s.allModels || []) {
    if (!enabledSet.has(m)) {
      orderedModels.push({ model: m, enabled: false });
    }
  }

  chromeProfiles = Array.isArray(s.chromeProfiles) ? [...s.chromeProfiles] : [];
  renderChromeProfilesUI();

  renderModelsList();
  populateVoiceSelect(knownVoices, s.voiceName ?? 'Nika');
  populateStyleSelect(knownStyles, s.voiceStyle ?? 'Podcast');
  $('cfgScenePrompt').value = s.scenePrompt || '';

  $('cfgWorkerCount').value = String(s.workerCount || 2);
  $('cfgQueueMode').value = s.queueMode || 'shared';
  $('cfgLimitChapters').value = s.limitChapters ?? 0;
  $('cfgForceRerun').checked = Boolean(s.forceRerun);

  const w1 = s.workers[0] || {};
  const w2 = s.workers[1] || {};
  if (w1.cdpUrl) $('w1CdpUrl').value = w1.cdpUrl;
  $('w1InitialModel').value = w1.initialModel || orderedModels[0]?.model || '';
  $('w1InputDir').value = w1.inputDir || '';
  $('w1OutputDir').value = w1.outputDir || '';
  $('w1PublishUrl').value = w1.publishUrl || '';

  if (w2.cdpUrl) $('w2CdpUrl').value = w2.cdpUrl;
  $('w2InitialModel').value = w2.initialModel || orderedModels[1]?.model || orderedModels[0]?.model || '';
  $('w2InputDir').value = w2.inputDir || '';
  $('w2OutputDir').value = w2.outputDir || '';
  $('w2PublishUrl').value = w2.publishUrl || '';

  $('cfgRotatePerChapter').checked = s.rotateModelPerChapter !== false;
  $('cfgRotateOnQuota').checked = s.rotateModelOnQuotaError !== false;

  $('cfgSplitParts').value = s.splitParts ?? 4;
  $('cfgMinCharsPerSplit').value = s.minCharsPerSplit ?? 300;
  $('cfgMaxWaitAudioSec').value = s.maxWaitAudioSec ?? 600;
  $('cfgMaxRetries').value = s.maxRetries ?? 2;
  $('cfgMinDelaySec').value = s.minDelaySec ?? 5;
  $('cfgMaxDelaySec').value = s.maxDelaySec ?? 10;
  $('cfgModelCooldownSec').value = s.modelCooldownSec ?? 300;
  $('cfgRateLimitCooldownSec').value = s.rateLimitCooldownSec ?? 60;
  $('cfgStopOnVerify').checked = s.stopOnAccountVerifyError !== false;
  $('cfgStopOnQuota').checked = Boolean(s.stopOnQuotaError);

  $('cfgPublishEnabled').checked = s.publishEnabled !== false;
  $('cfgAutoMerge').checked = s.autoMerge !== false;
  $('cfgCleanupAudio').checked = Boolean(s.cleanupAudioAfterPublish);
  $('cfgMergeGap').value = String(s.mergeGap ?? '0.4');
  $('cfgAacBitrate').value = s.aacBitrate || '48k';
  $('cfgMaxWaitUploadSec').value = s.maxWaitUploadSec ?? 300;

  updateVisibilityToggles();
  updateSplitHint();
}

function collectSettingsFromForm() {
  const enabledModels = orderedModels.filter((m) => m.enabled).map((m) => m.model);
  const allModels = orderedModels.map((m) => m.model);
  const customVoice = $('cfgVoiceCustom').value.trim();
  const voiceName = customVoice || $('cfgVoiceSelect').value;
  const customStyle = $('cfgStyleCustom').value.trim();
  const voiceStyle = customStyle || $('cfgStyleSelect').value;

  return {
    workerCount: Number($('cfgWorkerCount').value || 2),
    queueMode: $('cfgQueueMode').value,
    limitChapters: Number($('cfgLimitChapters').value || 0),
    forceRerun: $('cfgForceRerun').checked,
    allModels,
    enabledModels: enabledModels.length > 0 ? enabledModels : [allModels[0]],
    voiceName,
    voiceStyle,
    scenePrompt: $('cfgScenePrompt').value.trim(),
    rotateModelPerChapter: $('cfgRotatePerChapter').checked,
    rotateModelOnQuotaError: $('cfgRotateOnQuota').checked,
    splitParts: Number($('cfgSplitParts').value || 4),
    minCharsPerSplit: Number($('cfgMinCharsPerSplit').value || 300),
    maxWaitAudioSec: Number($('cfgMaxWaitAudioSec').value || 600),
    maxRetries: Number($('cfgMaxRetries').value ?? 2),
    minDelaySec: Number($('cfgMinDelaySec').value ?? 5),
    maxDelaySec: Number($('cfgMaxDelaySec').value ?? 10),
    modelCooldownSec: Number($('cfgModelCooldownSec').value || 300),
    rateLimitCooldownSec: Number($('cfgRateLimitCooldownSec').value || 60),
    stopOnAccountVerifyError: $('cfgStopOnVerify').checked,
    stopOnQuotaError: $('cfgStopOnQuota').checked,
    publishEnabled: $('cfgPublishEnabled').checked,
    autoMerge: $('cfgAutoMerge').checked,
    cleanupAudioAfterPublish: $('cfgCleanupAudio').checked,
    mergeGap: $('cfgMergeGap').value,
    aacBitrate: $('cfgAacBitrate').value,
    maxWaitUploadSec: Number($('cfgMaxWaitUploadSec').value || 300),
    chromeProfiles,
    workers: [
      {
        id: 1,
        name: 'Tác vụ 1',
        cdpUrl: $('w1CdpUrl').value.trim() || 'http://127.0.0.1:9222',
        initialModel: $('w1InitialModel').value,
        inputDir: $('w1InputDir').value.trim(),
        outputDir: $('w1OutputDir').value.trim(),
        publishUrl: $('w1PublishUrl').value.trim(),
      },
      {
        id: 2,
        name: 'Tác vụ 2',
        cdpUrl: $('w2CdpUrl').value.trim() || 'http://127.0.0.1:9222',
        initialModel: $('w2InitialModel').value,
        inputDir: $('w2InputDir').value.trim(),
        outputDir: $('w2OutputDir').value.trim(),
        publishUrl: $('w2PublishUrl').value.trim(),
      },
    ],
  };
}

function updateVisibilityToggles() {
  const wCount = Number($('cfgWorkerCount').value || 2);
  const qMode = $('cfgQueueMode').value;

  $('w2ConfigSubcard').style.display = wCount === 2 ? 'flex' : 'none';
  $('w2IndependentPaths').style.display = wCount === 2 && qMode === 'independent' ? 'block' : 'none';
  $('workerCard2').classList.toggle('inactive-slot', wCount === 1);
}

function updateSplitHint() {
  const parts = Math.max(1, Number($('cfgSplitParts').value || 1));
  const estChars = Math.round(10800 / parts);
  const estMin = (10 / parts).toFixed(1);
  $('splitHint').textContent =
    parts === 1
      ? 'Không chia phần (~10 phút / file audio).'
      : `Chương ~10,800 ký tự sẽ chia thành ${parts} phần (~${estChars} ký tự ≈ ${estMin} phút/phần), cắt đúng dấu chấm cuối đoạn.`;
}

/* ---------- Live State & Logs Rendering ---------- */

function renderState(state) {
  latestState = state;
  const isRunning = state.status === 'running';
  const isStopping = state.status === 'stopping';

  const badge = $('engineBadge');
  badge.className =
    'badge ' + (isRunning ? 'badge-running' : isStopping ? 'badge-stopping' : 'badge-idle');
  badge.textContent = isRunning
    ? 'ĐANG CHẠY'
    : isStopping
      ? 'ĐANG DỪNG AN TOÀN...'
      : 'SẴN SÀNG';

  $('btnStart').disabled = state.status !== 'idle';
  $('btnRetryFailed').disabled = state.status !== 'idle';
  $('btnPublishOnly').disabled = state.status !== 'idle';
  $('btnStop').disabled = state.status !== 'running';

  $('failedBadgeCount').textContent = state.failedCount ?? 0;

  const st = state.stats || {};
  const doneTotal = (st.completedChapters || 0) + (st.skippedChapters || 0) + (st.failedChapters || 0);
  const total = st.totalChapters || 0;
  const pct = total > 0 ? Math.min(100, Math.round((doneTotal / total) * 100)) : 0;

  $('globalProgressBar').style.width = `${pct}%`;
  $('globalProgressText').textContent = `Tiến độ: ${doneTotal} / ${total} chương (${pct}%)`;
  $('etaText').textContent = `Ước tính còn lại (ETA): ${formatDurationSec(st.etaSeconds)}`;

  $('statTotal').textContent = total;
  $('statCompleted').textContent = st.completedChapters || 0;
  $('statParts').textContent = st.partsSucceeded || 0;
  $('statPublished').textContent = st.publishedChapters || 0;
  $('statSkipped').textContent = st.skippedChapters || 0;
  $('statFailed').textContent = st.failedChapters || 0;

  // Workers
  (state.workers || []).forEach((w) => {
    const p = `w${w.id}`;
    if (!$(`${p}Badge`)) return;
    const badgeEl = $(`${p}Badge`);
    badgeEl.className = `phase-badge phase-${w.phase || 'idle'}`;
    badgeEl.textContent = PHASE_LABELS[w.phase] || w.phase;

    $(`${p}CdpLabel`).textContent = w.cdpUrl || (currentSettings?.workers?.[w.id - 1]?.cdpUrl ?? '');
    $(`${p}Model`).textContent = w.currentModel || '--';
    $(`${p}Voice`).textContent = w.voiceName || 'Mặc định';
    $(`${p}Done`).textContent = w.chaptersDone || 0;
    $(`${p}File`).textContent = w.currentFile
      ? w.totalParts > 1
        ? `${w.currentFile} (Phần ${w.currentPart}/${w.totalParts})`
        : w.currentFile
      : 'Chưa có chương đang xử lý';

    const partPct =
      w.totalParts > 0 ? Math.min(100, Math.round(((w.currentPart - 0.5) / w.totalParts) * 100)) : 0;
    $(`${p}PartBar`).style.width = w.active && w.phase === 'generating' ? `${Math.max(10, partPct)}%` : '0%';
    $(`${p}Message`).textContent = w.lastMessage || '';
    $(`${p}Timer`).textContent = w.partStartedAt ? formatTimerFromIso(w.partStartedAt) : '00:00';
  });

  renderModelsList();
}

function renderSummary(summary) {
  if (!summary) return;
  latestSummary = summary;
  renderChromeProfilesUI();

  const c1 = summary.inputCounts?.worker1 ?? 0;
  $('fileCountInfo').textContent = `Thư mục Input hiện có ${c1} file .txt`;
}

function matchesLogFilter(entry) {
  const filter = $('logFilter').value;
  if (filter === 'all') return true;
  if (filter === 'ERROR') return entry.level === 'ERROR' || entry.level === 'WARN';
  return String(entry.workerId) === filter;
}

function appendLogDom(entry) {
  if (!matchesLogFilter(entry)) return;
  const container = $('logContainer');
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="log-ts">[${entry.timestamp}]</span> <span class="log-${entry.level}">[${entry.level}]</span> `;
  const msgSpan = document.createElement('span');
  msgSpan.textContent = entry.message;
  div.appendChild(msgSpan);
  container.appendChild(div);

  while (container.children.length > 400) {
    container.removeChild(container.firstChild);
  }

  if ($('chkAutoScroll').checked) {
    container.scrollTop = container.scrollHeight;
  }
}

function rerenderAllLogs() {
  $('logContainer').innerHTML = '';
  for (const entry of allLogs) {
    appendLogDom(entry);
  }
}

/* ---------- Event Listeners ---------- */

function bindEvents() {
  // Settings Tabs
  document.querySelectorAll('.stab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.stab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.tab).classList.add('active');
    });
  });

  $('cfgWorkerCount').addEventListener('change', updateVisibilityToggles);
  $('cfgQueueMode').addEventListener('change', updateVisibilityToggles);
  $('cfgSplitParts').addEventListener('input', updateSplitHint);

  // Models list delegation (checkbox + move up/down)
  $('modelsListContainer').addEventListener('click', (e) => {
    const moveBtn = e.target.closest('button[data-move]');
    if (moveBtn) {
      const idx = Number(moveBtn.dataset.idx);
      const dir = moveBtn.dataset.move === 'up' ? -1 : 1;
      const targetIdx = idx + dir;
      if (targetIdx >= 0 && targetIdx < orderedModels.length) {
        const tmp = orderedModels[idx];
        orderedModels[idx] = orderedModels[targetIdx];
        orderedModels[targetIdx] = tmp;
        renderModelsList();
      }
      return;
    }

    const cb = e.target.closest('input.model-cb');
    if (cb) {
      const idx = Number(cb.dataset.idx);
      orderedModels[idx].enabled = cb.checked;
      populateWorkerModelDropdowns();
    }
  });

  $('btnAddModel').addEventListener('click', () => {
    const val = $('newModelInput').value.trim();
    if (!val) return;
    if (!orderedModels.some((m) => m.model === val)) {
      orderedModels.push({ model: val, enabled: true });
      renderModelsList();
    }
    $('newModelInput').value = '';
  });

  $('btnSaveSettings').addEventListener('click', async () => {
    try {
      const payload = collectSettingsFromForm();
      const res = await api('/api/settings', 'POST', payload);
      currentSettings = res.settings;
      renderSummary(res.summary);
      $('saveStatus').textContent = '✓ Đã lưu cấu hình!';
      setTimeout(() => {
        $('saveStatus').textContent = 'Tự lưu khi bấm Chạy';
      }, 2500);
    } catch (err) {
      alert(`Lỗi lưu cấu hình: ${err.message}`);
    }
  });

  async function triggerRun(mode) {
    try {
      const settings = collectSettingsFromForm();
      const res = await api('/api/start', 'POST', { mode, settings });
      renderState(res.state);
    } catch (err) {
      alert(`Không thể bắt đầu: ${err.message}`);
    }
  }

  $('btnStart').addEventListener('click', () => triggerRun('batch'));
  $('btnRetryFailed').addEventListener('click', () => triggerRun('retry-failed'));
  $('btnPublishOnly').addEventListener('click', () => triggerRun('publish-only'));

  $('btnStop').addEventListener('click', async () => {
    try {
      await api('/api/stop', 'POST');
    } catch (err) {
      alert(`Lỗi dừng: ${err.message}`);
    }
  });

  $('logFilter').addEventListener('change', rerenderAllLogs);
  $('btnClearLogs').addEventListener('click', async () => {
    allLogs = [];
    rerenderAllLogs();
    await api('/api/logs/clear', 'POST').catch(() => {});
  });

  // Shortcut "+ Hồ sơ Chrome" button in topbar
  $('btnGotoProfiles').addEventListener('click', () => {
    document.querySelectorAll('.stab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.stab-content').forEach((c) => c.classList.remove('active'));
    const tabBtn = document.querySelector('.stab[data-tab="tab-profiles"]');
    if (tabBtn) tabBtn.classList.add('active');
    $('tab-profiles').classList.add('active');
    $('newProfilePort').value = getNextSuggestedPort();
    $('newProfileName').focus();
  });

  // Add new Chrome profile
  $('btnAddProfile').addEventListener('click', async () => {
    const portVal = Number($('newProfilePort').value || getNextSuggestedPort());
    const nameVal = $('newProfileName').value.trim() || `Profile ${portVal}`;
    try {
      const res = await api('/api/profiles/add', 'POST', { name: nameVal, port: portVal });
      chromeProfiles = res.settings.chromeProfiles;
      currentSettings = res.settings;
      latestSummary = res.summary;
      $('newProfileName').value = '';
      $('newProfilePort').value = '';
      renderChromeProfilesUI();
    } catch (err) {
      alert(`Không thể tạo hồ sơ: ${err.message}`);
    }
  });

  // Delegated click handler for launching / assigning / deleting any Chrome profile
  document.body.addEventListener('click', async (e) => {
    const launchBtn = e.target.closest('[data-launch-profile]');
    if (launchBtn) {
      const profileId = launchBtn.dataset.launchProfile;
      launchBtn.disabled = true;
      try {
        await api('/api/chrome/launch', 'POST', { profileId });
        setTimeout(pollCdpSummary, 1800);
      } catch (err) {
        alert(`Lỗi mở Chrome: ${err.message}`);
      } finally {
        launchBtn.disabled = false;
      }
      return;
    }

    const assignBtn = e.target.closest('[data-assign-w]');
    if (assignBtn) {
      const wNum = assignBtn.dataset.assignW;
      const url = assignBtn.dataset.url;
      const sel = $(`w${wNum}CdpUrl`);
      if (sel) {
        sel.value = url;
        $('saveStatus').textContent = `✓ Đã gán cho Tác vụ ${wNum} (bấm Lưu hoặc Chạy)`;
      }
      return;
    }

    const delBtn = e.target.closest('[data-delete-profile]');
    if (delBtn) {
      const id = delBtn.dataset.deleteProfile;
      if (!confirm('Xóa hồ sơ này khỏi danh sách quản lý? (Dữ liệu đăng nhập trên ổ cứng vẫn được giữ an toàn)')) {
        return;
      }
      try {
        const res = await api('/api/profiles/delete', 'POST', { id });
        chromeProfiles = res.settings.chromeProfiles;
        currentSettings = res.settings;
        latestSummary = res.summary;
        renderChromeProfilesUI();
      } catch (err) {
        alert(`Lỗi xóa hồ sơ: ${err.message}`);
      }
    }
  });

  // Open folder buttons
  document.querySelectorAll('[data-open-folder]').forEach((btn) => {
    btn.addEventListener('click', () => {
      api('/api/open-folder', 'POST', { target: btn.dataset.openFolder }).catch((err) =>
        alert(err.message)
      );
    });
  });
}

async function pollCdpSummary() {
  try {
    const data = await api('/api/status');
    renderSummary(data.summary);
  } catch {
    // Ignore transient offline error
  }
}

async function init() {
  bindEvents();

  const boot = await api('/api/bootstrap');
  knownVoices = boot.knownVoices || [];
  knownStyles = boot.knownStyles || [];
  applySettingsToForm(boot.settings);
  renderState(boot.state);
  renderSummary(boot.summary);

  allLogs = boot.logs || [];
  rerenderAllLogs();

  // Connect SSE stream
  const es = new EventSource('/api/events');
  es.addEventListener('state', (ev) => {
    try {
      renderState(JSON.parse(ev.data));
    } catch {
      // Ignore
    }
  });
  es.addEventListener('log', (ev) => {
    try {
      const entry = JSON.parse(ev.data);
      allLogs.push(entry);
      if (allLogs.length > 400) allLogs.shift();
      appendLogDom(entry);
    } catch {
      // Ignore
    }
  });

  // Live 1s timer tick for active worker part timers
  setInterval(() => {
    if (!latestState || !latestState.workers) return;
    latestState.workers.forEach((w) => {
      const el = $(`w${w.id}Timer`);
      if (el) {
        el.textContent = w.partStartedAt ? formatTimerFromIso(w.partStartedAt) : '00:00';
      }
    });
  }, 1000);

  // Refresh Chrome CDP online indicators every 5s
  setInterval(pollCdpSummary, 5000);
}

init().catch((err) => {
  console.error(err);
  alert(`Không thể tải giao diện điều khiển: ${err.message}`);
});
