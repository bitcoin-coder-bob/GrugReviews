(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  let currentStep = null;
  let isStreaming = false;
  let fileListOpen = false;
  let lockedPart = null;

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

  const SECTION_COLORS = [
    '#00ffff', // cyan
    '#ff00aa', // magenta
    '#00ff88', // electric green
    '#ffff00', // yellow
    '#aa00ff', // purple
    '#ff6600', // orange
  ];

  function sectionColor(index) {
    return SECTION_COLORS[index % SECTION_COLORS.length];
  }

  function renderExplanationParts(parts) {
    if (!parts || !parts.length) return '';
    return parts.map(part => {
      const firstRef = part.refs && part.refs.length > 0 ? part.refs[0] % 6 : -1;
      const borderClass = firstRef >= 0 ? `ec-${firstRef}` : 'ec-none';
      const refsAttr = (part.refs || []).join(',');
      const extraDots = (part.refs || []).slice(1).map(ref =>
        `<span class="ex-dot ecd-${ref % 6}"></span>`
      ).join('');
      return `<div class="ex-part ${borderClass}" data-refs="${refsAttr}">
        ${extraDots ? `<div class="ex-extra-refs">${extraDots}</div>` : ''}
        <div class="ex-text">${renderText(part.text)}</div>
      </div>`;
    }).join('');
  }

  function showResume(session) {
    const { plan, stepIndex, contextLabel, savedAt } = session;
    const steps = plan.steps || [];
    const where = stepIndex < 0
      ? 'Lesson overview'
      : `Step ${stepIndex + 1} of ${steps.length}: ${steps[stepIndex]?.title || ''}`;
    const timeStr = savedAt
      ? new Date(savedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';

    root.innerHTML = `
      <div class="resume-screen">
        <div class="resume-heading">Resume last session?</div>
        ${contextLabel ? `<div class="context-label">${escHtml(contextLabel)}</div>` : ''}
        <div class="resume-title">${escHtml(plan.prTitle || 'PR Review')}</div>
        <div class="resume-where">${escHtml(where)}</div>
        ${timeStr ? `<div class="resume-time">Last opened ${escHtml(timeStr)}</div>` : ''}
        <div class="resume-buttons">
          <button class="btn btn-primary" id="btn-resume">Resume →</button>
          <button class="btn btn-secondary" id="btn-discard">Start Fresh</button>
        </div>
      </div>`;
    getEl('btn-resume').addEventListener('click', () => send({ type: 'resumeSession' }));
    getEl('btn-discard').addEventListener('click', () => {
      send({ type: 'discardSession' });
      showWelcome();
    });
  }

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
          <div class="grug-bash" id="grug-bash">
            <img id="grug-up" class="grug-bash-img" alt="">
            <img id="grug-down" class="grug-bash-img grug-hidden" alt="">
          </div>
          <div class="loading-title">Grug thinking hard...</div>
        </div>
        <div class="progress-log" id="progress-log"></div>
      </div>`;

    const upImg = getEl('grug-up');
    const downImg = getEl('grug-down');
    if (upImg && window.ELIG_MEDIA) {
      upImg.src = window.ELIG_MEDIA.cavemanUp;
      downImg.src = window.ELIG_MEDIA.cavemanDown;
    }

    let frame = 0;
    const interval = setInterval(() => {
      if (!getEl('grug-bash')) { clearInterval(interval); return; }
      frame = 1 - frame;
      upImg.classList.toggle('grug-hidden', frame === 1);
      downImg.classList.toggle('grug-hidden', frame === 0);
    }, 500);
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
    root.innerHTML = `
      <div class="error-screen">
        <div class="error-box">${escHtml(message)}</div>
        <div class="welcome-buttons" style="margin-top:12px">
          <button class="btn btn-primary" id="btn-grug-branch">🪨 Grug this Branch</button>
          <button class="btn btn-secondary" id="btn-grug-pr">📜 Grug a PR</button>
        </div>
      </div>`;
    getEl('btn-grug-branch').addEventListener('click', () => send({ type: 'runCommand', command: 'elig.grugBranch' }));
    getEl('btn-grug-pr').addEventListener('click', () => send({ type: 'runCommand', command: 'elig.grugPR' }));
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
  // fileCoverage: { [filename]: stepIndex[] }  (all steps that cover it)
  // currentIndex: the step we're on now
  function buildFileList(allFiles, fileCoverage, currentIndex) {
    if (!allFiles || allFiles.length === 0) return '';

    const items = allFiles.map(fp => {
      const stepIndices = fileCoverage != null && fp in fileCoverage ? fileCoverage[fp] : null;
      const basename = fp.split('/').pop() || fp;
      let cls = 'fl-item fl-pending';
      let icon = '○';
      let label = '';

      if (stepIndices && stepIndices.includes(currentIndex)) {
        cls = 'fl-item fl-current';
        icon = '●';
      } else if (stepIndices && stepIndices.every(i => i < currentIndex)) {
        cls = 'fl-item fl-done';
        icon = '✓';
      } else if (stepIndices && stepIndices.length > 0) {
        const future = stepIndices.filter(i => i > currentIndex);
        cls = 'fl-item fl-upcoming';
        icon = '○';
        label = future.length > 0
          ? 'step' + (future.length > 1 ? 's' : '') + ' ' + future.map(i => i + 1).join(', ')
          : 'steps ' + stepIndices.map(i => i + 1).join(', ');
      } else {
        label = 'uncovered';
      }

      return `<button class="${cls}" data-file="${escHtml(fp)}" title="${escHtml(fp)}">
        <span class="fl-icon">${icon}</span>
        <span class="fl-name">${escHtml(basename)}</span>
        ${label ? `<span class="fl-badge">${escHtml(label)}</span>` : ''}
      </button>`;
    }).join('');

    const covered = allFiles.filter(fp => fileCoverage != null && fp in fileCoverage && fileCoverage[fp].some(i => i <= currentIndex)).length;

    return `
      <details class="file-list-wrap"${fileListOpen ? ' open' : ''}>
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
    lockedPart = null;

    const { index, total, prTitle, modelName, contextLabel, allFiles, fileCoverage, stepTitles = [] } = data;
    const isFirst = index === 0;
    const isLast = index === total - 1;
    const pct = Math.round(((index + 1) / total) * 100);

    // Show at most 2 directory levels above filename; ellipsis if deeper
    function shortPath(fp) {
      const parts = fp.split('/');
      if (parts.length <= 3) return fp;
      return '…/' + parts.slice(-3).join('/');
    }

    // Per-step file list — sorted by color group so same colors are adjacent
    const indexedSections = (data.step.sections || []).map((sec, i) => ({ sec, i }));
    indexedSections.sort((a, b) => (a.i % 6) - (b.i % 6));

    const stepFileRows = indexedSections
      .map(({ sec, i }) => {
        const display = shortPath(sec.filename);
        const range = `${sec.startLine}–${sec.endLine}`;
        return `<button class="step-file-item section-chip sc-${i % 6}"
          data-file="${escHtml(sec.filename)}"
          data-start="${sec.startLine}"
          data-end="${sec.endLine}"
          data-index="${i}"
          title="${escHtml(sec.filename + ' — ' + sec.label)}"
        >
          <span class="step-file-name">${escHtml(display)}</span>
          <span class="step-file-range">${escHtml(range)}</span>
        </button>`;
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

      ${stepFileRows ? `<div class="step-file-wrap"><div class="step-file-header"><span>This step</span><span class="fl-counter">${(data.step.sections || []).length} section${(data.step.sections || []).length !== 1 ? 's' : ''}</span></div><div class="step-file-list">${stepFileRows}</div></div>` : ''}

      <div class="explanation" id="explanation">${data.step.explanationParts && data.step.explanationParts.length ? renderExplanationParts(data.step.explanationParts) : renderText(data.step.explanation)}</div>

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

    const fileListWrap = root.querySelector('.file-list-wrap');
    if (fileListWrap) {
      fileListWrap.addEventListener('toggle', () => { fileListOpen = fileListWrap.open; });
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

    // Explanation hover/click -> pop matching file rows
    const stepFileList = root.querySelector('.step-file-list');

    function applyPop(refs) {
      if (!stepFileList) return;
      stepFileList.classList.add('has-hover');
      refs.forEach(ref => {
        const item = root.querySelector(`.step-file-item[data-index="${ref}"]`);
        if (item) item.classList.add('popped');
      });
    }

    function clearPop() {
      if (!stepFileList) return;
      stepFileList.classList.remove('has-hover');
      root.querySelectorAll('.step-file-item.popped').forEach(f => f.classList.remove('popped'));
    }

    root.querySelectorAll('.ex-part[data-refs]').forEach(el => {
      const raw = el.dataset.refs || '';
      const refs = raw ? raw.split(',').map(Number).filter(n => !isNaN(n)) : [];
      if (!refs.length || !stepFileList) return;

      el.addEventListener('mouseenter', () => {
        if (lockedPart) return;
        applyPop(refs);
      });

      el.addEventListener('mouseleave', () => {
        if (lockedPart) return;
        clearPop();
      });

      el.addEventListener('click', () => {
        if (lockedPart === el) {
          // Unlock
          el.classList.remove('locked');
          lockedPart = null;
          clearPop();
        } else {
          // Lock this one, release any previous lock
          if (lockedPart) {
            lockedPart.classList.remove('locked');
            clearPop();
          }
          lockedPart = el;
          el.classList.add('locked');
          applyPop(refs);
        }
      });
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
      case 'showResume':   showResume(msg.session);      break;
      case 'error':        showError(msg.message);       break;
      case 'streamStart': onStreamStart();              break;
      case 'streamChunk': onStreamChunk(msg.text);      break;
      case 'streamDone':  onStreamDone();               break;
      case 'streamError': onStreamError(msg.text);      break;
    }
  });

  showWelcome();
  send({ type: 'webviewReady' });
})();
