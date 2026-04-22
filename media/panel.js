(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  let currentStep = null;
  let isStreaming = false;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Render backtick code spans and **bold** from model output
  function renderText(str) {
    if (!str) return '';
    return escHtml(str)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  let streamBuffer = '';

  function send(msg) { vscode.postMessage(msg); }
  function getEl(id) { return document.getElementById(id); }

  function setAllButtonsDisabled(disabled) {
    ['btn-dumber', 'btn-rephrase', 'btn-next', 'btn-back', 'btn-ask'].forEach(id => {
      const el = getEl(id);
      if (el) el.disabled = disabled;
    });
    const input = getEl('ask-input');
    if (input) input.disabled = disabled;
  }

  // ── Screens ───────────────────────────────────────────────────────────────

  const ELIG_VERSION = window.ELIG_VERSION || '?';

  function showWelcome() {
    root.innerHTML = `
      <div class="welcome">
        <div class="welcome-logo">ELIG</div>
        <div class="welcome-tagline">Explain Like I'm Grug</div>
        <div class="welcome-buttons">
          <button class="btn btn-primary" id="btn-grug-branch">🪨 Grug this Branch</button>
          <button class="btn btn-secondary" id="btn-grug-pr">📜 Grug a PR</button>
        </div>
        <div class="welcome-version">v${escHtml(ELIG_VERSION)}</div>
      </div>`;
    getEl('btn-grug-branch').addEventListener('click', () => send({ type: 'runCommand', command: 'elig.grugBranch' }));
    getEl('btn-grug-pr').addEventListener('click', () => send({ type: 'runCommand', command: 'elig.grugPR' }));
  }

  function showSummary(data) {
    const { prTitle, summary, modelName, contextLabel, allFiles = [], stepTitles = [] } = data;
    const modelBadge = modelName
      ? `<span class="model-badge">${escHtml(modelName)}</span>`
      : '';
    const contextBadge = contextLabel
      ? `<div class="context-label">${escHtml(contextLabel)}</div>`
      : '';

    const fileItems = allFiles
      .map(f => `<div class="summary-file">${escHtml(f)}</div>`)
      .join('');

    const stepItems = stepTitles
      .map((t, i) => `<button class="summary-step summary-step-btn" data-index="${i}"><span class="summary-step-num">${i + 1}</span><span class="summary-step-text">${escHtml(t)}</span></button>`)
      .join('');

    root.innerHTML = `
      <div class="summary-screen">
        ${contextBadge}
        <div class="summary-heading">Lesson Overview</div>
        <div class="summary-header">
          <div class="summary-pr-title">${escHtml(prTitle || 'PR Review')}</div>
          ${modelBadge}
        </div>
        <div class="summary-body">${renderText(summary || '')}</div>
        <div class="summary-sections">
          <div class="summary-section">
            <div class="summary-section-label">${allFiles.length} file${allFiles.length !== 1 ? 's' : ''} changed</div>
            <div class="summary-file-list">${fileItems}</div>
          </div>
          <div class="summary-section">
            <div class="summary-section-label">${stepTitles.length} lesson step${stepTitles.length !== 1 ? 's' : ''} — click to jump</div>
            <div class="summary-step-list">${stepItems}</div>
          </div>
        </div>
        <button class="btn btn-primary summary-start" id="btn-start">Start from Step 1 →</button>
      </div>`;
    getEl('btn-start').addEventListener('click', () => send({ type: 'startLesson' }));
    root.querySelectorAll('.summary-step-btn[data-index]').forEach(el => {
      el.addEventListener('click', () => send({ type: 'goToStep', index: parseInt(el.dataset.index, 10) }));
    });
  }

  function showLoading() {
    root.innerHTML = `
      <div class="loading">
        <div class="loading-top">
          <div class="spinner"></div>
          <div class="loading-title">Grug thinking hard...</div>
        </div>
        <div class="progress-log" id="progress-log"></div>
      </div>`;
  }

  function onProgress(text) {
    let log = getEl('progress-log');
    if (!log) {
      // Loading screen may not be visible yet — show it first
      showLoading();
      log = getEl('progress-log');
    }
    if (!log) return;

    // Mark the previous last line as done
    const prev = log.querySelector('.progress-line.active');
    if (prev) {
      prev.classList.remove('active');
      prev.classList.add('done');
    }

    const line = document.createElement('div');
    line.className = 'progress-line active';
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function showError(message) {
    root.innerHTML = `<div class="error-box">${escHtml(message)}</div>`;
  }

  function showDone() {
    root.innerHTML = `
      <div class="done">
        <div class="done-title">DONE</div>
        <div class="done-sub">Grug understand now.</div>
        <div class="welcome-buttons" style="margin-top:16px">
          <button class="btn btn-primary" id="btn-grug-branch">🪨 Grug this Branch</button>
          <button class="btn btn-secondary" id="btn-grug-pr">📜 Grug a PR</button>
        </div>
      </div>`;
    getEl('btn-grug-branch').addEventListener('click', () => send({ type: 'runCommand', command: 'elig.grugBranch' }));
    getEl('btn-grug-pr').addEventListener('click', () => send({ type: 'runCommand', command: 'elig.grugPR' }));
  }

  // Build the all-files list HTML.
  // fileCoverage: { [filename]: stepIndex }  (which step first covers it)
  // currentIndex: the step we're on now
  function buildFileList(allFiles, fileCoverage, currentIndex) {
    if (!allFiles || allFiles.length === 0) return '';

    const items = allFiles.map(fp => {
      const stepIdx = fileCoverage != null && fp in fileCoverage ? fileCoverage[fp] : null;
      const basename = fp.split('/').pop() || fp;
      let cls = 'fl-item fl-pending';
      let icon = '○';
      let label = '';

      if (stepIdx === currentIndex) {
        cls = 'fl-item fl-current';
        icon = '●';
      } else if (stepIdx !== null && stepIdx < currentIndex) {
        cls = 'fl-item fl-done';
        icon = '✓';
      } else if (stepIdx !== null && stepIdx > currentIndex) {
        cls = 'fl-item fl-upcoming';
        icon = '○';
        label = `step ${stepIdx + 1}`;
      } else {
        label = 'uncovered';
      }

      return `<button class="${cls}" data-file="${escHtml(fp)}" title="${escHtml(fp)}">
        <span class="fl-icon">${icon}</span>
        <span class="fl-name">${escHtml(basename)}</span>
        ${label ? `<span class="fl-badge">${escHtml(label)}</span>` : ''}
      </button>`;
    }).join('');

    const covered = allFiles.filter(fp => fileCoverage != null && fp in fileCoverage && fileCoverage[fp] <= currentIndex).length;

    return `
      <details class="file-list-wrap">
        <summary class="file-list-summary">
          <span>Files changed</span>
          <span class="fl-counter">${covered} of ${allFiles.length} explained</span>
        </summary>
        <div class="file-list">${items}</div>
      </details>`;
  }

  function showStep(data) {
    currentStep = data.step;
    isStreaming = false;

    const { index, total, prTitle, modelName, contextLabel, allFiles, fileCoverage, stepTitles = [] } = data;
    const isFirst = index === 0;
    const isLast = index === total - 1;
    const pct = Math.round(((index + 1) / total) * 100);

    // Per-step section chips — one per code section with line range
    const stepFileChips = (data.step.sections || [])
      .map(sec => {
        const basename = sec.filename.split('/').pop() || sec.filename;
        const range = `${sec.startLine}–${sec.endLine}`;
        const chipLabel = `${basename}:${range}`;
        return `<button class="file-chip section-chip"
          data-file="${escHtml(sec.filename)}"
          data-start="${sec.startLine}"
          data-end="${sec.endLine}"
          title="${escHtml(sec.filename + ':' + range + ' — ' + sec.label)}"
        >${escHtml(chipLabel)}</button>`;
      })
      .join('');

    const modelBadge = modelName
      ? `<span class="model-badge" title="AI model being used">${escHtml(modelName)}</span>`
      : '';
    const contextBadge = contextLabel
      ? `<div class="context-label">${escHtml(contextLabel)}</div>`
      : '';

    root.innerHTML = `
      <div class="header">
        ${contextBadge}
        <div class="header-top">
          <div class="pr-title">${escHtml(prTitle || 'PR Review')}</div>
          ${modelBadge}
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="progress-label">Step ${index + 1} of ${total}</div>
        ${stepTitles.length > 1 ? `<select class="step-nav" id="step-nav">${stepTitles.map((t, i) => `<option value="${i}"${i === index ? ' selected' : ''}>${i + 1}. ${escHtml(t)}</option>`).join('')}</select>` : ''}
      </div>

      ${buildFileList(allFiles, fileCoverage, index)}

      <div class="step-title">${escHtml(data.step.title)}</div>

      ${stepFileChips ? `<div class="files-list"><span class="files-list-label">This step:</span>${stepFileChips}</div>` : ''}

      <div class="explanation" id="explanation">${renderText(data.step.explanation)}</div>

      <div class="buttons">
        <button class="btn btn-secondary" id="btn-dumber">Explain like I&rsquo;m even dumber</button>
        <button class="btn btn-secondary" id="btn-rephrase">Rephrase this</button>
        <div class="ask-bar">
          <input class="ask-input" id="ask-input" type="text" placeholder="Ask Grug anything about this step…" autocomplete="off">
          <button class="btn btn-secondary ask-send" id="btn-ask">Ask</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">← ${isFirst ? 'Summary' : 'Back'}</button>
          <button class="btn btn-primary" id="btn-next">${isLast ? 'Done ✓' : 'I get this →'}</button>
        </div>
      </div>`;

    function sendAsk() {
      const input = getEl('ask-input');
      const q = input ? input.value.trim() : '';
      if (!q || isStreaming) return;
      input.value = '';
      send({ type: 'askGrug', question: q });
    }

    const stepNav = getEl('step-nav');
    if (stepNav) {
      stepNav.addEventListener('change', () => {
        if (!isStreaming) send({ type: 'goToStep', index: parseInt(stepNav.value, 10) });
      });
    }

    getEl('btn-dumber').addEventListener('click', () => { if (!isStreaming) send({ type: 'dumberPlease' }); });
    getEl('btn-rephrase').addEventListener('click', () => { if (!isStreaming) send({ type: 'rephrase' }); });
    getEl('btn-ask').addEventListener('click', sendAsk);
    getEl('ask-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendAsk(); });
    getEl('btn-next').addEventListener('click', () => {
      if (isStreaming) return;
      if (isLast) showDone(); else send({ type: 'nextStep' });
    });
    getEl('btn-back').addEventListener('click', () => {
      if (isStreaming) return;
      if (isFirst) send({ type: 'goToSummary' }); else send({ type: 'prevStep' });
    });

    // File list chips (all-files panel) — open file at its first hunk
    root.querySelectorAll('.fl-item[data-file]').forEach(el => {
      el.addEventListener('click', () => send({ type: 'openFile', filename: el.dataset.file }));
    });

    // Section chips — open file at the specific line range
    root.querySelectorAll('.section-chip[data-file]').forEach(el => {
      el.addEventListener('click', () => send({
        type: 'openFile',
        filename: el.dataset.file,
        startLine: parseInt(el.dataset.start, 10),
        endLine: parseInt(el.dataset.end, 10),
      }));
    });
  }

  // ── Stream handlers ───────────────────────────────────────────────────────

  function onStreamStart() {
    isStreaming = true;
    streamBuffer = '';
    const el = getEl('explanation');
    if (el) { el.innerHTML = ''; el.classList.add('streaming'); }
    setAllButtonsDisabled(true);
  }

  function onStreamChunk(text) {
    streamBuffer += text;
    // Show raw text while streaming so the cursor blink works cleanly
    const el = getEl('explanation');
    if (el) el.textContent = streamBuffer;
  }

  function onStreamDone() {
    isStreaming = false;
    const el = getEl('explanation');
    if (el) {
      el.classList.remove('streaming');
      el.innerHTML = renderText(streamBuffer);
      if (currentStep) currentStep.explanation = streamBuffer;
    }
    streamBuffer = '';
    setAllButtonsDisabled(false);
  }

  function onStreamError(text) {
    isStreaming = false;
    streamBuffer = '';
    const el = getEl('explanation');
    if (el) { el.classList.remove('streaming'); el.textContent = '(Error: ' + text + ')'; }
    setAllButtonsDisabled(false);
  }

  // ── Message listener ──────────────────────────────────────────────────────

  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'loading':      showLoading();               break;
      case 'progress':     onProgress(msg.text);        break;
      case 'showSummary':  showSummary(msg);             break;
      case 'showStep':     showStep(msg);                break;
      case 'error':        showError(msg.message);       break;
      case 'streamStart': onStreamStart();              break;
      case 'streamChunk': onStreamChunk(msg.text);      break;
      case 'streamDone':  onStreamDone();               break;
      case 'streamError': onStreamError(msg.text);      break;
    }
  });

  showWelcome();
})();
