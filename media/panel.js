(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  // Font size — persisted in webview state; applied as CSS scale on root
  let fontSize = (vscode.getState() || {}).fontSize || 13;
  function applyFontSize() {
    const scale = fontSize / 13;
    root.style.transform = scale === 1 ? '' : `scale(${scale})`;
    root.style.width = scale === 1 ? '' : `${(1 / scale) * 100}%`;
    root.style.height = scale === 1 ? '' : `${(1 / scale) * 100}%`;
  }
  applyFontSize();

  let currentStep = null;
  let currentStepIndex = -1;
  const stepAskHistory = new Map(); // stepIndex -> last answer string
  let isStreaming = false;
  let fileListOpen = false;
  let lockedPart = null;
  let currentExplanationParts = null;
  let currentSections = null;
  let expandingPartIndex = -1;
  const stepScrollPos = new Map();
  let lastStreamMode = null;
  let lastAskQuestion = '';
  let lastRunCommand = null;
  const stepNotes = new Map(); // stepIndex -> note string
  let hideCompletedSteps = false;

  // Keyboard shortcuts — active whenever we're on the step screen
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const next = getEl('btn-next');
    const back = getEl('btn-back');
    if (e.key === 'ArrowRight' && next && !next.disabled) {
      e.preventDefault(); next.click();
    } else if (e.key === 'ArrowLeft' && back && !back.disabled) {
      e.preventDefault(); back.click();
    } else if (e.key === '/' && getEl('ask-input')) {
      e.preventDefault(); getEl('ask-input').focus();
    } else if (e.key === 'Escape' && document.activeElement === getEl('ask-input')) {
      getEl('ask-input').blur();
    }
  });

  function shortPath(fp) {
    const parts = fp.split('/');
    if (parts.length <= 3) return fp;
    return '…/' + parts.slice(-3).join('/');
  }

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
    ['btn-dumber', 'btn-rephrase', 'btn-review', 'btn-learn', 'btn-risk', 'btn-next', 'btn-back', 'btn-ask', 'btn-compare'].forEach(id => {
      const el = getEl(id);
      if (el) el.disabled = disabled;
    });
    const input = getEl('ask-input');
    if (input) input.disabled = disabled;
    root.querySelectorAll('.ex-expand-btn').forEach(btn => { btn.disabled = disabled; });
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
    return parts.map((part, idx) => {
      const firstRef = part.refs && part.refs.length > 0 ? part.refs[0] % 6 : -1;
      const borderClass = firstRef >= 0 ? `ec-${firstRef}` : 'ec-none';
      const refsAttr = (part.refs || []).join(',');
      const extraDots = (part.refs || []).slice(1).map(ref =>
        `<span class="ex-dot ecd-${ref % 6}"></span>`
      ).join('');
      const jumpChips = (part.refs || []).filter(ref => currentSections && currentSections[ref]).map(ref => {
        const sec = currentSections[ref];
        const colorIdx = ref % 6;
        const hasDiff = sec.diffLines?.length > 0;
        return `<button class="ex-jump-chip sc-${colorIdx}"
          data-file="${escHtml(sec.filename)}"
          data-start="${sec.startLine}"
          data-end="${sec.endLine}"
          data-color="${escHtml(SECTION_COLORS[colorIdx])}"
          data-part-index="${idx}"
          title="${escHtml(sec.filename)}"
        ><span class="ex-chip-label">${escHtml(shortPath(sec.filename))} ${sec.startLine}–${sec.endLine}</span>${hasDiff ? `<span class="ex-chip-diff-zone" data-filename="${escHtml(sec.filename)}" data-start="${sec.startLine}" data-end="${sec.endLine}" title="Open diff in editor">⊞</span>` : ''}</button>`;
      }).join('');
      return `<div class="ex-part ${borderClass}" data-refs="${refsAttr}" data-part-index="${idx}">
        ${extraDots ? `<div class="ex-extra-refs">${extraDots}</div>` : ''}
        <div class="ex-text">${renderText(part.text)}</div>
        ${jumpChips ? `<div class="ex-jump-chips">${jumpChips}</div>` : ''}
        <div class="ex-part-actions">
          <button class="ex-expand-btn" data-part-index="${idx}">▸ more detail</button>
          <button class="ex-copy-btn" data-part-index="${idx}" title="Copy this paragraph">⎘</button>
        </div>
        <div class="ex-expand-content" id="ex-expand-${idx}"></div>
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

  const WALKTHROUGH_SLIDES = [
    {
      title: 'Welcome to ELIG',
      body: 'ELIG turns any PR or branch diff into a guided lesson. Instead of scrolling through a wall of changes, you get a step-by-step walkthrough in plain English — with the relevant code highlighted in your editor as you go.',
      hint: '1 of 3',
    },
    {
      title: 'Pick your diff source',
      body: '<b>Branch</b> — changes on your current branch vs. main (or your configured base).<br><br><b>Local Changes</b> — uncommitted edits in your working tree.<br><br><b>PR</b> — any GitHub pull request by number or URL.',
      hint: '2 of 3',
    },
    {
      title: 'Navigate and explore',
      body: 'Step through changes with the arrow keys or buttons. Ask follow-up questions, request a simpler explanation, generate a QA checklist, or run a risk analysis — all without leaving the panel.',
      hint: '3 of 3',
    },
  ];

  function showWalkthrough(slideIndex = 0) {
    const slide = WALKTHROUGH_SLIDES[slideIndex];
    const isLast = slideIndex === WALKTHROUGH_SLIDES.length - 1;
    root.innerHTML = `
      <div class="walkthrough">
        <div class="wt-logo">ELIG</div>
        <div class="wt-hint">${slide.hint}</div>
        <div class="wt-title">${slide.title}</div>
        <div class="wt-body">${slide.body}</div>
        <div class="wt-pip-row">${WALKTHROUGH_SLIDES.map((_, i) =>
          `<span class="wt-pip${i === slideIndex ? ' wt-pip-active' : ''}"></span>`
        ).join('')}</div>
        <div class="wt-buttons">
          <button class="btn btn-secondary" id="btn-wt-skip">Skip</button>
          <button class="btn btn-primary" id="btn-wt-next">${isLast ? 'Get started →' : 'Next →'}</button>
        </div>
      </div>`;
    getEl('btn-wt-skip').addEventListener('click', () => {
      send({ type: 'walkthroughComplete' });
      showWelcome();
    });
    getEl('btn-wt-next').addEventListener('click', () => {
      if (isLast) {
        send({ type: 'walkthroughComplete' });
        showWelcome();
      } else {
        showWalkthrough(slideIndex + 1);
      }
    });
  }

  function showWelcome() {
    root.innerHTML = `
      <div class="welcome">
        <div class="welcome-logo">ELIG</div>
        <div class="welcome-tagline">Explain Like I'm Grug</div>
        <div class="welcome-desc">Pick a diff source and Grug will walk you through every change in plain English, one step at a time.</div>
        <div class="welcome-buttons">
          <button class="btn btn-primary" id="btn-grug-branch">🪨 Grug this Branch</button>
          <button class="btn btn-secondary" id="btn-grug-staged">📦 Grug Local Changes</button>
          <button class="btn btn-secondary" id="btn-grug-pr">📜 Grug a PR</button>
          <button class="btn btn-secondary" id="btn-import">📂 Import lesson (.md)</button>
        </div>
        <div class="welcome-hints">
          <div class="welcome-hint"><span class="wh-cmd">Branch</span> changes since your base branch (e.g. main)</div>
          <div class="welcome-hint"><span class="wh-cmd">Local</span> uncommitted edits in the working tree</div>
          <div class="welcome-hint"><span class="wh-cmd">PR</span> any GitHub pull request by number or URL</div>
        </div>
        <div class="welcome-version">v${escHtml(ELIG_VERSION)}</div>
      </div>`;
    getEl('btn-grug-branch').addEventListener('click', () => { lastRunCommand = 'elig.grugBranch'; send({ type: 'runCommand', command: 'elig.grugBranch' }); });
    getEl('btn-grug-staged').addEventListener('click', () => { lastRunCommand = 'elig.grugStaged'; send({ type: 'runCommand', command: 'elig.grugStaged' }); });
    getEl('btn-grug-pr').addEventListener('click', () => { lastRunCommand = 'elig.grugPR'; send({ type: 'runCommand', command: 'elig.grugPR' }); });
    getEl('btn-import').addEventListener('click', () => send({ type: 'importLesson' }));
  }

  function showSummary(data) {
    const { prTitle, summary, modelName, contextLabel, allFiles = [], fileStats = [], totalAdditions = 0, totalDeletions = 0, fromBranch = '', toBranch = '', stepTitles = [], completedSteps = [], hasPRInfo = false, qaChecklist = '', riskAnalysis = '' } = data;
    const modelBadge = modelName
      ? `<span class="model-badge">${escHtml(modelName)}</span>`
      : '';
    const statMap = {};
    fileStats.forEach(s => { statMap[s.filename] = s; });

    const fileCount = allFiles.length;
    const contextHero = contextLabel
      ? `<div class="summary-context-hero">
           <div class="summary-context-label">${escHtml(contextLabel)}</div>
           <div class="summary-context-meta">${fileCount} file${fileCount !== 1 ? 's' : ''} changed &nbsp;·&nbsp; <span class="diff-add">+${totalAdditions}</span> <span class="diff-del">-${totalDeletions}</span></div>
         </div>`
      : '';

    const branchRow = (fromBranch && toBranch)
      ? `<div class="diff-branch-row"><span class="diff-branch">${escHtml(fromBranch)}</span><span class="diff-arrow">→</span><span class="diff-branch">${escHtml(toBranch)}</span></div>`
      : '';
    const diffStatBar = branchRow
      ? `<div class="diff-stat-bar">${branchRow}</div>`
      : '';

    function fileStatusBadge(status) {
      if (status === 'added')   return `<span class="file-status-badge fsb-added">A</span>`;
      if (status === 'removed') return `<span class="file-status-badge fsb-removed">D</span>`;
      if (status === 'renamed') return `<span class="file-status-badge fsb-renamed">R</span>`;
      return '';
    }

    function summaryFileBtn(f) {
      const st = statMap[f];
      const badge = st ? fileStatusBadge(st.status) : '';
      const statHtml = st
        ? `<span class="summary-file-stats"><span class="diff-add">+${st.additions}</span><span class="diff-del">-${st.deletions}</span></span>`
        : '';
      return `<button class="summary-file${st?.status === 'added' ? ' fsb-file-added' : st?.status === 'removed' ? ' fsb-file-removed' : ''}" data-file="${escHtml(f)}" title="${escHtml(f)}">${badge}<span class="summary-file-name">${escHtml(f)}</span>${statHtml}</button>`;
    }

    // Group files by top-level folder for tree view
    const byFolder = new Map();
    for (const f of allFiles) {
      const slash = f.indexOf('/');
      const folder = slash >= 0 ? f.slice(0, slash) : '';
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(f);
    }
    const namedFolders = [...byFolder.keys()].filter(k => k !== '');
    const useTree = namedFolders.length > 1;

    let fileItems = '';
    if (!useTree) {
      fileItems = allFiles.map(summaryFileBtn).join('');
    } else {
      if (byFolder.has('')) {
        fileItems += byFolder.get('').map(summaryFileBtn).join('');
      }
      for (const folder of namedFolders.sort()) {
        fileItems += `<div class="tree-folder-group"><div class="tree-folder-name">📁 ${escHtml(folder)}/</div>`;
        fileItems += byFolder.get(folder).map(summaryFileBtn).join('');
        fileItems += `</div>`;
      }
    }

    const stepItems = stepTitles
      .map((t, i) => {
        const done = completedSteps.includes(i);
        return `<button class="summary-step summary-step-btn${done ? ' summary-step-done' : ''}" data-index="${i}"><span class="summary-step-num${done ? ' step-num-done' : ''}">${done ? '✓' : i + 1}</span><span class="summary-step-text">${escHtml(t)}</span></button>`;
      })
      .join('');

    root.innerHTML = `
      <div class="summary-screen">
        ${contextHero}
        ${diffStatBar}
        <div class="summary-heading">Lesson Overview</div>
        <div class="summary-header">
          <div class="summary-pr-title">${escHtml(prTitle || 'PR Review')}</div>
          ${modelBadge}
          <button class="btn-restart" id="btn-restart" title="Start a new Grug session">↺</button>
        </div>
        <div class="summary-body">${renderText(summary || '')}</div>
        <div class="summary-sections">
          <div class="summary-section">
            <div class="summary-section-label">${allFiles.length} file${allFiles.length !== 1 ? 's' : ''} changed</div>
            <div class="summary-file-list">${fileItems}</div>
          </div>
          <div class="summary-section">
            <div class="summary-section-label-row">
              <span>${stepTitles.length} lesson step${stepTitles.length !== 1 ? 's' : ''} — click to jump</span>
              ${completedSteps.length > 0 ? `<button class="btn-hide-done" id="btn-hide-done">${hideCompletedSteps ? 'Show all' : 'Hide completed'}</button>` : ''}
            </div>
            <div class="summary-step-list${hideCompletedSteps ? ' hide-completed' : ''}" id="summary-step-list">${stepItems}</div>
          </div>
        </div>
        <div class="summary-actions">
          <button class="btn btn-secondary" id="btn-export" title="Save this lesson as a Markdown file you can share or import later">⬇ Export as .md</button>
          <button class="btn btn-secondary" id="btn-reanalyze" title="Re-fetch the latest diff and regenerate the lesson from scratch">↺ Re-analyze</button>
          <button class="btn btn-secondary" id="btn-checklist" title="Ask the AI to generate a manual QA checklist — what a reviewer should actually test based on these changes">☑ QA Checklist</button>
          <button class="btn btn-secondary" id="btn-risk-analysis" title="Ask the AI what could go wrong across all changes — edge cases, unchecked errors, fragile code">⚠ What could go wrong?</button>
          ${hasPRInfo ? `<button class="btn btn-secondary" id="btn-post-pr" title="Post this lesson as a comment on the GitHub PR so teammates can read it">📣 Post to GitHub</button>` : ''}
        </div>
        <div class="checklist-output" id="checklist-output"></div>
        <div class="checklist-output" id="risk-analysis-output"></div>
        <button class="btn btn-primary summary-start" id="btn-start">Start from Step 1 →</button>
      </div>`;
    getEl('btn-start').addEventListener('click', () => send({ type: 'startLesson' }));
    getEl('btn-restart').addEventListener('click', () => { send({ type: 'discardSession' }); showWelcome(); });
    getEl('btn-export').addEventListener('click', () => send({ type: 'exportLesson' }));
    getEl('btn-reanalyze').addEventListener('click', () => send({ type: 'reanalyze' }));
    getEl('btn-checklist').addEventListener('click', () => {
      const btn = getEl('btn-checklist');
      if (btn) { btn.disabled = true; btn.textContent = '☑ Generating…'; }
      getEl('checklist-output').innerHTML = '';
      send({ type: 'generateChecklist' });
    });
    getEl('btn-risk-analysis').addEventListener('click', () => {
      const btn = getEl('btn-risk-analysis');
      if (btn) { btn.disabled = true; btn.textContent = '⚠ Analyzing…'; }
      getEl('risk-analysis-output').innerHTML = '';
      send({ type: 'generateRiskAnalysis' });
    });
    if (hasPRInfo) {
      getEl('btn-post-pr').addEventListener('click', () => {
        const btn = getEl('btn-post-pr');
        if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
        const existing = btn?.parentElement?.querySelector('.pr-comment-error');
        if (existing) existing.remove();
        send({ type: 'postPRComment' });
      });
    }
    root.querySelectorAll('.summary-file[data-file]').forEach(el => {
      el.addEventListener('click', () => send({ type: 'showDiffInEditor', filename: el.dataset.file }));
    });
    root.querySelectorAll('.summary-step-btn[data-index]').forEach(el => {
      el.addEventListener('click', () => send({ type: 'goToStep', index: parseInt(el.dataset.index, 10) }));
    });
    const hideDoneBtn = getEl('btn-hide-done');
    if (hideDoneBtn) {
      hideDoneBtn.addEventListener('click', () => {
        hideCompletedSteps = !hideCompletedSteps;
        hideDoneBtn.textContent = hideCompletedSteps ? 'Show all' : 'Hide completed';
        const list = getEl('summary-step-list');
        if (list) list.classList.toggle('hide-completed', hideCompletedSteps);
      });
    }

    if (qaChecklist) {
      checklistBuffer = qaChecklist;
      onChecklistDone();
    }
    if (riskAnalysis) {
      riskAnalysisBuffer = riskAnalysis;
      onRiskAnalysisDone();
    }
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
    const retryBtn = lastRunCommand
      ? `<button class="btn btn-primary" id="btn-retry-cmd">↺ Try again</button>`
      : '';
    root.innerHTML = `
      <div class="error-screen">
        <div class="error-title">Grug confused</div>
        <div class="error-box">${escHtml(message)}</div>
        <div class="welcome-buttons" style="margin-top:12px">
          ${retryBtn}
          <button class="btn btn-secondary" id="btn-grug-branch">🪨 Grug this Branch</button>
          <button class="btn btn-secondary" id="btn-grug-staged">📦 Grug Local Changes</button>
          <button class="btn btn-secondary" id="btn-grug-pr">📜 Grug a PR</button>
        </div>
      </div>`;
    if (lastRunCommand) {
      getEl('btn-retry-cmd').addEventListener('click', () => send({ type: 'runCommand', command: lastRunCommand }));
    }
    getEl('btn-grug-branch').addEventListener('click', () => { lastRunCommand = 'elig.grugBranch'; send({ type: 'runCommand', command: 'elig.grugBranch' }); });
    getEl('btn-grug-staged').addEventListener('click', () => { lastRunCommand = 'elig.grugStaged'; send({ type: 'runCommand', command: 'elig.grugStaged' }); });
    getEl('btn-grug-pr').addEventListener('click', () => { lastRunCommand = 'elig.grugPR'; send({ type: 'runCommand', command: 'elig.grugPR' }); });
  }

  function showDone() {
    root.innerHTML = `
      <div class="done">
        <div class="done-title">DONE</div>
        <div class="done-sub">Grug understand now.</div>
        <div class="welcome-buttons" style="margin-top:16px">
          <button class="btn btn-primary" id="btn-grug-branch">🪨 Grug this Branch</button>
          <button class="btn btn-secondary" id="btn-grug-staged">📦 Grug Local Changes</button>
          <button class="btn btn-secondary" id="btn-grug-pr">📜 Grug a PR</button>
        </div>
      </div>`;
    getEl('btn-grug-branch').addEventListener('click', () => send({ type: 'runCommand', command: 'elig.grugBranch' }));
    getEl('btn-grug-staged').addEventListener('click', () => send({ type: 'runCommand', command: 'elig.grugStaged' }));
    getEl('btn-grug-pr').addEventListener('click', () => send({ type: 'runCommand', command: 'elig.grugPR' }));
  }

  // Build the all-files list HTML.
  // fileCoverage: { [filename]: stepIndex[] }  (all steps that cover it)
  // currentIndex: the step we're on now
  function buildFileList(allFiles, fileCoverage, currentIndex, fileStats) {
    if (!allFiles || allFiles.length === 0) return '';

    const statMap = {};
    if (fileStats) fileStats.forEach(s => { statMap[s.filename] = s; });

    const items = allFiles.map(fp => {
      const stepIndices = fileCoverage != null && fp in fileCoverage ? fileCoverage[fp] : null;
      const basename = fp.split('/').pop() || fp;
      const st = statMap[fp];
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

      const statusBadge = st?.status === 'added'
        ? `<span class="fl-status-badge fsb-added">A</span>`
        : st?.status === 'removed'
        ? `<span class="fl-status-badge fsb-removed">D</span>`
        : st?.status === 'renamed'
        ? `<span class="fl-status-badge fsb-renamed">R</span>`
        : '';

      return `<button class="${cls}" data-file="${escHtml(fp)}" title="${escHtml(fp)}">
        <span class="fl-icon">${icon}</span>
        <span class="fl-name">${escHtml(basename)}</span>
        ${statusBadge}
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
    expandingPartIndex = -1;
    currentExplanationParts = data.step.explanationParts || null;
    currentSections = data.step.sections || null;

    const { index, total, prTitle, modelName, contextLabel, allFiles, fileCoverage, fileStats, stepTitles = [], completedSteps = [], qaChecklist = '', riskAnalysis = '' } = data;
    const isFirst = index === 0;
    const isLast = index === total - 1;
    const pct = Math.round(((index + 1) / total) * 100);

    // Breadcrumb — unique files in this step, compact chips above the title
    const uniqueStepFiles = [...new Set((data.step.sections || []).map(s => s.filename))];
    const breadcrumb = uniqueStepFiles.length
      ? `<div class="step-breadcrumb">${uniqueStepFiles.map(f =>
          `<button class="breadcrumb-chip" data-file="${escHtml(f)}" title="${escHtml(f)}">${escHtml(shortPath(f))}</button>`
        ).join('<span class="breadcrumb-sep">·</span>')}</div>`
      : '';

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
          title="${escHtml(sec.filename)}"
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
          <div class="font-size-controls">
            <button class="btn-font" id="btn-font-down" title="Decrease font size">A−</button>
            <button class="btn-font" id="btn-font-up" title="Increase font size">A+</button>
          </div>
          <button class="btn-restart" id="btn-restart" title="Start a new Grug session">↺</button>
          <button class="btn-help" id="btn-help" title="Keyboard shortcuts">?</button>
        </div>
        <div class="help-popover" id="help-popover">
          <div class="help-row"><kbd>→</kbd> next step</div>
          <div class="help-row"><kbd>←</kbd> back</div>
          <div class="help-row"><kbd>/</kbd> ask Grug</div>
          <div class="help-row"><kbd>Esc</kbd> dismiss input</div>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="progress-label">Step ${index + 1} of ${total}</div>
        ${stepTitles.length > 1 ? `<select class="step-nav" id="step-nav">${stepTitles.map((t, i) => `<option value="${i}"${i === index ? ' selected' : ''}>${completedSteps.includes(i) ? '✓ ' : ''}${i + 1}. ${escHtml(t)}</option>`).join('')}</select>` : ''}
      </div>

      ${buildFileList(allFiles, fileCoverage, index, fileStats)}

      ${breadcrumb}
      <div class="step-title">${escHtml(data.step.title)}</div>
      ${data.step.confidence === 'low' || data.step.confidence === 'medium'
        ? `<div class="confidence-warning cc-${escHtml(data.step.confidence)}"><span class="confidence-icon">⚠</span><span class="confidence-text">${escHtml(data.step.uncertainty || 'Grug not fully sure about this one.')}</span></div>`
        : ''}

      ${stepFileRows ? `<div class="step-file-wrap"><div class="step-file-header"><span>This step</span><span class="fl-counter">${(data.step.sections || []).length} section${(data.step.sections || []).length !== 1 ? 's' : ''}</span></div><div class="step-file-list">${stepFileRows}</div></div>` : ''}

      <div class="explanation" id="explanation">${data.step.explanationParts && data.step.explanationParts.length ? renderExplanationParts(data.step.explanationParts) : renderText(data.step.explanation)}</div>

      <div class="buttons">
        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-dumber">Explain like I&rsquo;m even dumber</button>
          <button class="btn btn-secondary" id="btn-rephrase">Rephrase this</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary btn-mode" id="btn-review" title="Reviewer lens: what changed and why">📋 What changed</button>
          <button class="btn btn-secondary btn-mode" id="btn-learn" title="Learner lens: what the code does">📚 Explain code</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary btn-mode btn-risk" id="btn-risk" title="What edge cases or bugs could this introduce?">⚠ What could go wrong?</button>
        </div>
        <div class="stream-status" id="stream-status"></div>
        <div class="ask-bar">
          <input class="ask-input" id="ask-input" type="text" placeholder="Ask Grug anything about this step…" autocomplete="off">
          <button class="btn btn-secondary ask-send" id="btn-ask">Ask</button>
        </div>
        <div class="ask-answer" id="ask-answer"></div>
        ${total > 1 ? `<div class="compare-bar">
          <span class="compare-label">vs</span>
          <select class="compare-select" id="compare-select">${stepTitles.map((t, i) => i === index ? '' : `<option value="${i}">${i + 1}. ${escHtml(t)}</option>`).join('')}</select>
          <input class="ask-input compare-input" id="compare-input" type="text" placeholder="How do these relate?" autocomplete="off">
          <button class="btn btn-secondary ask-send" id="btn-compare">Ask</button>
        </div>
        <div class="compare-answer" id="compare-answer"></div>` : ''}
        <div class="step-notes-wrap">
          <textarea class="step-notes" id="step-notes" rows="2" placeholder="Add a note for this step…" spellcheck="false"></textarea>
        </div>
        ${qaChecklist ? `<details class="cl-details cl-details-step" id="step-checklist">
          <summary class="cl-summary"><span class="cl-summary-label">☑ QA Checklist</span><span class="cl-summary-count">${(qaChecklist.match(/^- \[/gm) || []).length} items</span></summary>
          <div class="cl-body" id="step-checklist-body">${renderChecklist(qaChecklist)}</div>
        </details>` : ''}
        ${riskAnalysis ? `<details class="cl-details cl-details-step" id="step-risk-analysis">
          <summary class="cl-summary"><span class="cl-summary-label">⚠ What could go wrong?</span><span class="cl-summary-count">${(riskAnalysis.match(/^- /gm) || []).length} risks</span></summary>
          <div class="cl-body">${renderRiskAnalysis(riskAnalysis)}</div>
        </details>` : ''}
        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-back">← ${isFirst ? 'Summary' : 'Back'}</button>
          <button class="btn btn-primary" id="btn-next">${isLast ? 'Done ✓' : 'I get this →'}</button>
        </div>
      </div>`;

    // Scroll memory — restore saved position for this step, update tracker
    currentStepIndex = index;
    const savedScroll = stepScrollPos.get(index);
    if (savedScroll != null) {
      const expEl = getEl('explanation');
      if (expEl) expEl.scrollTop = savedScroll;
    }

    // Restore persisted ask answer for this step
    const savedAsk = stepAskHistory.get(index);
    if (savedAsk) {
      const askEl = getEl('ask-answer');
      if (askEl) askEl.innerHTML = renderText(savedAsk);
    }

    // Restore note for this step
    const allStepNotes = data.stepNotes || {};
    if (allStepNotes[index]) stepNotes.set(index, allStepNotes[index]);
    const noteEl = getEl('step-notes');
    if (noteEl) noteEl.value = stepNotes.get(index) || '';

    // Breadcrumb click — open file at its first section in this step
    root.querySelectorAll('.breadcrumb-chip[data-file]').forEach(el => {
      el.addEventListener('click', () => {
        const firstSec = (data.step.sections || []).find(s => s.filename === el.dataset.file);
        send({ type: 'openFile', filename: el.dataset.file,
               startLine: firstSec?.startLine, endLine: firstSec?.endLine });
      });
    });

    function sendAsk() {
      const input = getEl('ask-input');
      const q = input ? input.value.trim() : '';
      if (!q || isStreaming) return;
      lastAskQuestion = q;
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

    getEl('btn-font-up').addEventListener('click', () => {
      fontSize = Math.min(20, fontSize + 1);
      applyFontSize();
      vscode.setState({ ...(vscode.getState() || {}), fontSize });
    });
    getEl('btn-font-down').addEventListener('click', () => {
      fontSize = Math.max(10, fontSize - 1);
      applyFontSize();
      vscode.setState({ ...(vscode.getState() || {}), fontSize });
    });
    getEl('btn-restart').addEventListener('click', () => { send({ type: 'discardSession' }); showWelcome(); });
    getEl('btn-help').addEventListener('click', () => {
      const p = getEl('help-popover');
      if (p) p.classList.toggle('open');
    });
    getEl('btn-dumber').addEventListener('click', () => { if (!isStreaming) { lastStreamMode = 'dumberPlease'; send({ type: 'dumberPlease' }); } });
    getEl('btn-rephrase').addEventListener('click', () => { if (!isStreaming) { lastStreamMode = 'rephrase'; send({ type: 'rephrase' }); } });
    getEl('btn-review').addEventListener('click', () => { if (!isStreaming) { lastStreamMode = 'reviewMode'; send({ type: 'reviewMode' }); } });
    getEl('btn-learn').addEventListener('click', () => { if (!isStreaming) { lastStreamMode = 'learnMode'; send({ type: 'learnMode' }); } });
    getEl('btn-risk').addEventListener('click', () => { if (!isStreaming) { lastStreamMode = 'riskMode'; send({ type: 'riskMode' }); } });

    if (noteEl) {
      noteEl.addEventListener('input', () => {
        stepNotes.set(index, noteEl.value);
        send({ type: 'saveStepNote', stepIndex: index, note: noteEl.value });
      });
    }

    root.querySelectorAll('#step-checklist .cl-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        cb.closest('.cl-item')?.classList.toggle('cl-checked', cb.checked);
      });
    });

    const compareSelectEl = getEl('compare-select');
    const compareInputEl = getEl('compare-input');
    const btnCompare = getEl('btn-compare');
    if (btnCompare && compareInputEl && compareSelectEl) {
      function sendCompare() {
        const q = compareInputEl.value.trim();
        const otherIdx = parseInt(compareSelectEl.value, 10);
        if (!q || isNaN(otherIdx) || isStreaming) return;
        compareInputEl.value = '';
        send({ type: 'compareSteps', otherStepIndex: otherIdx, question: q });
      }
      btnCompare.addEventListener('click', sendCompare);
      compareInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') sendCompare(); });
    }
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

          // Highlight all referenced sections in the editor with their neon colors
          const sections = refs
            .filter(ref => data.step.sections[ref])
            .map(ref => ({
              filename: data.step.sections[ref].filename,
              startLine: data.step.sections[ref].startLine,
              endLine: data.step.sections[ref].endLine,
              color: SECTION_COLORS[ref % 6],
            }));
          if (sections.length) send({ type: 'openSections', sections });
        }
      });
    });

    // Jump chips — navigate to a specific section, highlight all in that explainer
    root.querySelectorAll('.ex-jump-chip').forEach(chip => {
      // Diff zone inside the chip
      chip.querySelector('.ex-chip-diff-zone')?.addEventListener('click', e => {
        e.stopPropagation();
        const zone = e.currentTarget;
        send({
          type: 'showDiffInEditor',
          filename: zone.dataset.filename,
          startLine: parseInt(zone.dataset.start, 10),
          endLine: parseInt(zone.dataset.end, 10),
        });
      });

      chip.addEventListener('click', e => {
        if (e.target.closest('.ex-chip-diff-zone')) return; // handled above
        e.stopPropagation();
        const part = chip.closest('.ex-part');
        const raw = part?.dataset.refs || '';
        const refs = raw ? raw.split(',').map(Number).filter(n => !isNaN(n)) : [];
        const sections = refs
          .filter(ref => data.step.sections[ref])
          .map(ref => ({
            filename: data.step.sections[ref].filename,
            startLine: data.step.sections[ref].startLine,
            endLine: data.step.sections[ref].endLine,
            color: SECTION_COLORS[ref % 6],
          }));
        send({ type: 'openSections', sections, jumpToFilename: chip.dataset.file, jumpToLine: parseInt(chip.dataset.start, 10) });
      });
    });


    // Copy paragraph buttons
    root.querySelectorAll('.ex-copy-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const partIdx = parseInt(btn.dataset.partIndex, 10);
        const part = currentExplanationParts?.[partIdx];
        if (!part) return;
        navigator.clipboard.writeText(part.text).then(() => {
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = '⎘'; }, 1500);
        });
      });
    });

    // More detail buttons
    root.querySelectorAll('.ex-expand-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation(); // don't trigger the lock click on parent
        if (isStreaming || expandingPartIndex >= 0) return;
        const partIdx = parseInt(btn.dataset.partIndex, 10);
        const part = currentExplanationParts?.[partIdx];
        if (!part) return;
        send({ type: 'expandPart', partIndex: partIdx, partText: part.text, partRefs: part.refs || [] });
      });
    });
  }

  // ── Stream handlers ───────────────────────────────────────────────────────

  const STREAM_MODE_LABELS = {
    dumberPlease: 'Making simpler…',
    rephrase: 'Rephrasing…',
    reviewMode: 'Switching to reviewer lens…',
    learnMode: 'Switching to learner lens…',
    riskMode: 'Checking for risks…',
  };

  function setStreamStatus(text) {
    const el = getEl('stream-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('stream-status-active', !!text);
  }

  function onStreamStart() {
    isStreaming = true;
    streamBuffer = '';
    const el = getEl('explanation');
    if (el) { el.innerHTML = ''; el.classList.add('streaming'); }
    setAllButtonsDisabled(true);
    setStreamStatus(STREAM_MODE_LABELS[lastStreamMode] || 'Grug thinking…');
  }

  function onStreamChunk(text) {
    streamBuffer += text;
    setStreamStatus('');
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
    setStreamStatus('');
    setAllButtonsDisabled(false);
  }

  function onStreamError(text) {
    isStreaming = false;
    streamBuffer = '';
    setStreamStatus('');
    const el = getEl('explanation');
    if (el) {
      el.classList.remove('streaming');
      const retryHtml = lastStreamMode
        ? ` <button class="btn-inline-retry" id="btn-stream-retry">↺ Retry</button>`
        : '';
      el.innerHTML = `<span class="inline-error">Error: ${escHtml(text)}</span>${retryHtml}`;
      if (lastStreamMode) {
        el.querySelector('#btn-stream-retry')?.addEventListener('click', () => {
          send({ type: lastStreamMode });
        });
      }
    }
    setAllButtonsDisabled(false);
  }

  // ── Ask Grug handlers ────────────────────────────────────────────────────

  let askBuffer = '';

  function onAskStart() {
    askBuffer = '';
    setAllButtonsDisabled(true);
    setStreamStatus('Asking Grug…');
    const el = getEl('ask-answer');
    if (el) { el.innerHTML = '<span class="ex-expand-loading">Grug thinking...</span>'; el.classList.add('ask-streaming'); }
  }

  function onAskChunk(text) {
    askBuffer += text;
    const el = getEl('ask-answer');
    if (el) el.textContent = askBuffer;
  }

  function onAskDone() {
    setAllButtonsDisabled(false);
    setStreamStatus('');
    const el = getEl('ask-answer');
    if (el) { el.classList.remove('ask-streaming'); el.innerHTML = renderText(askBuffer); }
    if (currentStepIndex >= 0 && askBuffer) stepAskHistory.set(currentStepIndex, askBuffer);
    askBuffer = '';
  }

  function onAskError(text) {
    setAllButtonsDisabled(false);
    setStreamStatus('');
    askBuffer = '';
    const el = getEl('ask-answer');
    if (el) {
      el.classList.remove('ask-streaming');
      const retryHtml = lastAskQuestion
        ? ` <button class="btn-inline-retry" id="btn-ask-retry">↺ Retry</button>`
        : '';
      el.innerHTML = `<span class="inline-error">Error: ${escHtml(text)}</span>${retryHtml}`;
      if (lastAskQuestion) {
        el.querySelector('#btn-ask-retry')?.addEventListener('click', () => {
          send({ type: 'askGrug', question: lastAskQuestion });
        });
      }
    }
  }

  // ── Compare steps handlers ───────────────────────────────────────────────

  let compareBuffer = '';

  function onCompareStart() {
    compareBuffer = '';
    setAllButtonsDisabled(true);
    setStreamStatus('Asking Grug about both steps…');
    const el = getEl('compare-answer');
    if (el) { el.innerHTML = '<span class="ex-expand-loading">Grug comparing…</span>'; el.classList.add('ask-streaming'); }
  }

  function onCompareChunk(text) {
    compareBuffer += text;
    setStreamStatus('');
    const el = getEl('compare-answer');
    if (el) el.textContent = compareBuffer;
  }

  function onCompareDone() {
    setAllButtonsDisabled(false);
    setStreamStatus('');
    const el = getEl('compare-answer');
    if (el) { el.classList.remove('ask-streaming'); el.innerHTML = renderText(compareBuffer); }
    compareBuffer = '';
  }

  function onCompareError(text) {
    setAllButtonsDisabled(false);
    setStreamStatus('');
    compareBuffer = '';
    const el = getEl('compare-answer');
    if (el) { el.classList.remove('ask-streaming'); el.innerHTML = `<span class="inline-error">Error: ${escHtml(text)}</span>`; }
  }

  // ── Expand (more detail) handlers ────────────────────────────────────────

  let expandBuffer = '';

  function onExpandStart(partIndex) {
    expandingPartIndex = partIndex;
    expandBuffer = '';
    setAllButtonsDisabled(true);
    setStreamStatus('Digging deeper…');
    const el = getEl(`ex-expand-${partIndex}`);
    if (el) { el.innerHTML = '<span class="ex-expand-loading">Grug digging deeper...</span>'; }
    const btn = root.querySelector(`.ex-expand-btn[data-part-index="${partIndex}"]`);
    if (btn) btn.textContent = '...';
  }

  function onExpandChunk(partIndex, text) {
    if (partIndex !== expandingPartIndex) return;
    expandBuffer += text;
    const el = getEl(`ex-expand-${partIndex}`);
    if (el) el.textContent = expandBuffer;
  }

  function onExpandDone(partIndex) {
    expandingPartIndex = -1;
    setAllButtonsDisabled(false);
    setStreamStatus('');
    const el = getEl(`ex-expand-${partIndex}`);
    if (el) el.innerHTML = renderText(expandBuffer);
    expandBuffer = '';
    const btn = root.querySelector(`.ex-expand-btn[data-part-index="${partIndex}"]`);
    if (btn) btn.textContent = '↻ re-explain';
  }

  function onExpandError(partIndex, text) {
    expandingPartIndex = -1;
    setAllButtonsDisabled(false);
    setStreamStatus('');
    expandBuffer = '';
    const el = getEl(`ex-expand-${partIndex}`);
    if (el) el.textContent = '(Error: ' + text + ')';
    const btn = root.querySelector(`.ex-expand-btn[data-part-index="${partIndex}"]`);
    if (btn) btn.textContent = '▸ more detail';
  }

  // ── Checklist handlers ───────────────────────────────────────────────────

  let checklistBuffer = '';

  function renderChecklist(text) {
    // Parse the model's "- [ ] item" format into interactive checkboxes.
    // Lines that don't start with "- [ ]" are treated as section headers.
    const lines = text.split('\n');
    let html = '';
    let itemId = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const isItem = /^- \[[ x]\]/i.test(line);
      if (isItem) {
        const checked = /^- \[x\]/i.test(line);
        const labelText = line.replace(/^- \[[ x]\]\s*/i, '');
        const id = `cl-item-${itemId++}`;
        html += `<label class="cl-item${checked ? ' cl-checked' : ''}" for="${id}">
          <input type="checkbox" id="${id}" class="cl-checkbox"${checked ? ' checked' : ''}>
          <span class="cl-text">${renderText(labelText)}</span>
        </label>`;
      } else {
        const headerText = line.replace(/:$/, '');
        html += `<div class="cl-header">${escHtml(headerText)}</div>`;
      }
    }
    return html;
  }

  function onChecklistStart() {
    checklistBuffer = '';
    const out = getEl('checklist-output');
    if (out) { out.innerHTML = '<div class="cl-progress" id="cl-progress"><span class="cl-progress-dot"></span>Asking model to review the diff…</div>'; }
  }

  function onChecklistChunk(text) {
    checklistBuffer += text;
    const out = getEl('checklist-output');
    if (!out) return;
    const itemCount = (checklistBuffer.match(/^- \[/gm) || []).length;
    const progressEl = getEl('cl-progress');
    if (progressEl) {
      progressEl.innerHTML = `<span class="cl-progress-dot"></span>Receiving… ${itemCount} item${itemCount !== 1 ? 's' : ''} so far`;
    } else {
      out.innerHTML = `<div class="cl-progress" id="cl-progress"><span class="cl-progress-dot"></span>Receiving… ${itemCount} item${itemCount !== 1 ? 's' : ''} so far</div>`;
    }
  }

  function onChecklistDone() {
    const btn = getEl('btn-checklist');
    if (btn) { btn.disabled = false; btn.textContent = '☑ QA Checklist'; }
    const out = getEl('checklist-output');
    if (out) {
      const itemCount = (checklistBuffer.match(/^- \[/gm) || []).length;
      out.innerHTML = `<details class="cl-details" open>
        <summary class="cl-summary"><span class="cl-summary-label">QA Checklist</span><span class="cl-summary-count">${itemCount} item${itemCount !== 1 ? 's' : ''}</span></summary>
        <div class="cl-body">${renderChecklist(checklistBuffer)}</div>
      </details>`;
      out.querySelectorAll('.cl-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
          cb.closest('.cl-item')?.classList.toggle('cl-checked', cb.checked);
        });
      });
    }
    checklistBuffer = '';
  }

  function onChecklistError(text) {
    const btn = getEl('btn-checklist');
    if (btn) { btn.disabled = false; btn.textContent = '☑ QA Checklist'; }
    const out = getEl('checklist-output');
    if (out) out.innerHTML = `<span class="inline-error">Error: ${escHtml(text)}</span>`;
    checklistBuffer = '';
  }

  // ── Risk analysis handlers ────────────────────────────────────────────────

  let riskAnalysisBuffer = '';

  function renderRiskAnalysis(text) {
    const lines = text.split('\n');
    let html = '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const isItem = /^- /.test(line);
      if (isItem) {
        const body = line.slice(2);
        html += `<div class="risk-item">${renderText(body)}</div>`;
      } else {
        html += `<div class="cl-header">${escHtml(line.replace(/:$/, ''))}</div>`;
      }
    }
    return html;
  }

  function onRiskAnalysisStart() {
    riskAnalysisBuffer = '';
    const out = getEl('risk-analysis-output');
    if (out) out.innerHTML = '<div class="cl-progress"><span class="cl-progress-dot"></span>Asking model to review all changes…</div><pre class="risk-stream" id="risk-stream"></pre>';
  }

  function onRiskAnalysisChunk(text) {
    riskAnalysisBuffer += text;
    const streamEl = getEl('risk-stream');
    if (streamEl) streamEl.textContent = riskAnalysisBuffer;
  }

  function onRiskAnalysisDone() {
    const btn = getEl('btn-risk-analysis');
    if (btn) { btn.disabled = false; btn.textContent = '⚠ What could go wrong?'; }
    const out = getEl('risk-analysis-output');
    if (out) {
      const itemCount = (riskAnalysisBuffer.match(/^- /gm) || []).length;
      out.innerHTML = `<details class="cl-details" open>
        <summary class="cl-summary"><span class="cl-summary-label">⚠ What could go wrong?</span><span class="cl-summary-count">${itemCount} risk${itemCount !== 1 ? 's' : ''}</span></summary>
        <div class="cl-body">${renderRiskAnalysis(riskAnalysisBuffer)}</div>
      </details>`;
    }
    riskAnalysisBuffer = '';
  }

  function onRiskAnalysisError(text) {
    const btn = getEl('btn-risk-analysis');
    if (btn) { btn.disabled = false; btn.textContent = '⚠ What could go wrong?'; }
    const out = getEl('risk-analysis-output');
    if (out) out.innerHTML = `<span class="inline-error">Error: ${escHtml(text)}</span>`;
    riskAnalysisBuffer = '';
  }

  // ── Message listener ──────────────────────────────────────────────────────

  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'loading':      showLoading();               break;
      case 'progress':     onProgress(msg.text);        break;
      case 'showSummary':  showSummary(msg);             break;
      case 'showStep':
        if (currentStepIndex >= 0) {
          const exp = getEl('explanation');
          if (exp) stepScrollPos.set(currentStepIndex, exp.scrollTop);
        }
        showStep(msg);
        break;
      case 'showResume':     showResume(msg.session);      break;
      case 'showWalkthrough': showWalkthrough();           break;
      case 'error':          showError(msg.message);      break;
      case 'streamStart': onStreamStart();              break;
      case 'streamChunk': onStreamChunk(msg.text);      break;
      case 'streamDone':  onStreamDone();               break;
      case 'streamError': onStreamError(msg.text);      break;
      case 'askStart':    onAskStart();                              break;
      case 'askChunk':    onAskChunk(msg.text);                      break;
      case 'askDone':     onAskDone();                               break;
      case 'askError':    onAskError(msg.text);                      break;
      case 'expandStart': onExpandStart(msg.partIndex);              break;
      case 'expandChunk': onExpandChunk(msg.partIndex, msg.text);    break;
      case 'expandDone':  onExpandDone(msg.partIndex);               break;
      case 'expandError': onExpandError(msg.partIndex, msg.text);    break;
      case 'compareStart': onCompareStart();                         break;
      case 'compareChunk': onCompareChunk(msg.text);                 break;
      case 'compareDone':  onCompareDone();                          break;
      case 'compareError': onCompareError(msg.text);                 break;
      case 'checklistStart': onChecklistStart();                          break;
      case 'checklistChunk': onChecklistChunk(msg.text);                 break;
      case 'checklistDone':  onChecklistDone();                          break;
      case 'checklistError': onChecklistError(msg.text);                 break;
      case 'riskAnalysisStart': onRiskAnalysisStart();                   break;
      case 'riskAnalysisChunk': onRiskAnalysisChunk(msg.text);           break;
      case 'riskAnalysisDone':  onRiskAnalysisDone();                    break;
      case 'riskAnalysisError': onRiskAnalysisError(msg.text);           break;
      case 'prCommentPosted': {
        const btn = getEl('btn-post-pr');
        if (btn) { btn.textContent = '✓ Posted!'; btn.disabled = true; }
        break;
      }
      case 'prCommentError': {
        const btn2 = getEl('btn-post-pr');
        if (btn2) {
          btn2.textContent = '📣 Post to GitHub';
          btn2.disabled = false;
          const existing = btn2.parentElement?.querySelector('.pr-comment-error');
          if (existing) existing.remove();
          const errEl = document.createElement('div');
          errEl.className = 'pr-comment-error';
          errEl.textContent = msg.message || 'Request failed';
          btn2.parentElement?.appendChild(errEl);
        }
        break;
      }
    }
  });

  showWelcome();
  send({ type: 'webviewReady' });
})();
