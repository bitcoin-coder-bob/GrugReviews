import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { DiffFile, LessonPlan, LessonStep } from './types';
import {
  generateLessonPlan,
  reexplain,
  askQuestion,
  expandExplanation,
  selectModel,
  modelDisplayName,
  stepFilenames,
  buildFileCoverage,
} from './lessonGenerator';

interface FileStat {
  filename: string;
  additions: number;
  deletions: number;
}

interface SavedSession {
  plan: LessonPlan;
  stepIndex: number; // -1 = at summary, 0+ = at step
  contextLabel: string;
  allFiles: string[];
  fileStats: FileStat[];
  modelName: string;
  fromBranch: string;
  toBranch: string;
  completedSteps: number[];
  savedAt: number;
  prOwner: string;
  prRepo: string;
  prNumber: number;
}

export class EligDiffProvider implements vscode.TextDocumentContentProvider {
  private _contents = new Map<string, string>();

  set(key: string, content: string): void { this._contents.set(key, content); }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this._contents.get(uri.path.replace(/^\//, '')) ?? '';
  }
}

export class EligPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'elig.lessonPanel';

  private _view?: vscode.WebviewView;
  private _plan?: LessonPlan;
  private _allFiles: string[] = [];
  private _fileStats: FileStat[] = [];
  private _stepIndex = 0;
  private _modelName = '';
  private _contextLabel = '';
  private _fromBranch = '';
  private _toBranch = '';
  private _completedSteps = new Set<number>();
  private _summaryData?: object;
  private _diffFiles: DiffFile[] = [];
  private _prOwner = '';
  private _prRepo = '';
  private _prNumber = 0;
  private _decorations: vscode.TextEditorDecorationType[] = [];
  private _diffBase = 'HEAD';
  private _pendingLoad?: { diffFiles: DiffFile[]; cts: vscode.CancellationTokenSource };

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _diffProvider: EligDiffProvider,
  ) {}

  private get _extensionUri(): vscode.Uri { return this._context.extensionUri; }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg));

    if (this._pendingLoad) {
      const { diffFiles, cts } = this._pendingLoad;
      this._pendingLoad = undefined;
      this._doLoad(diffFiles, cts);
    }
    // panel.js sends 'webviewReady' once its listener is live — respond with resume prompt if applicable
  }

  private _saveSession(stepIndex: number): void {
    if (!this._plan) return;
    const session: SavedSession = {
      plan: this._plan,
      stepIndex,
      contextLabel: this._contextLabel,
      allFiles: this._allFiles,
      fileStats: this._fileStats,
      modelName: this._modelName,
      fromBranch: this._fromBranch,
      toBranch: this._toBranch,
      completedSteps: [...this._completedSteps],
      savedAt: Date.now(),
      prOwner: this._prOwner,
      prRepo: this._prRepo,
      prNumber: this._prNumber,
    };
    this._context.workspaceState.update('elig.session', session);
  }

  private _checkSavedSession(): void {
    if (this._pendingLoad) return; // a fresh load is about to come in
    const session = this._context.workspaceState.get<SavedSession>('elig.session');
    if (!session?.plan?.steps?.length) return;
    this._post({ type: 'showResume', session });
  }

  async loadLesson(diffFiles: DiffFile[], cts: vscode.CancellationTokenSource, contextLabel = '', diffBase = 'HEAD', fromBranch = '', toBranch = '', prInfo?: { owner: string; repo: string; prNumber: number }): Promise<void> {
    this._contextLabel = contextLabel;
    this._diffBase = diffBase;
    this._fromBranch = fromBranch;
    this._toBranch = toBranch;
    this._prOwner = prInfo?.owner ?? '';
    this._prRepo = prInfo?.repo ?? '';
    this._prNumber = prInfo?.prNumber ?? 0;
    await vscode.commands.executeCommand('elig.lessonPanel.focus');

    if (!this._view) {
      this._pendingLoad = { diffFiles, cts };
      return;
    }

    await this._doLoad(diffFiles, cts);
  }

  private async _doLoad(diffFiles: DiffFile[], cts: vscode.CancellationTokenSource): Promise<void> {
    this._diffFiles = diffFiles;
    this._allFiles = diffFiles.map(f => f.filename);
    this._fileStats = diffFiles.map(f => ({ filename: f.filename, additions: f.additions, deletions: f.deletions }));
    this._completedSteps = new Set<number>();

    let model: vscode.LanguageModelChat;
    try {
      model = await selectModel();
    } catch (err: any) {
      this._post({ type: 'error', message: err.message ?? String(err) });
      return;
    }

    this._modelName = modelDisplayName(model);
    this._post({ type: 'loading' });
    this._post({ type: 'progress', text: `Using ${this._modelName}` });

    const postProgress = (text: string) => this._post({ type: 'progress', text });

    try {
      const plan = await generateLessonPlan(diffFiles, model, cts.token, postProgress);
      this._plan = plan;
      this._stepIndex = 0;
      const totalAdditions = this._fileStats.reduce((s, f) => s + f.additions, 0);
      const totalDeletions = this._fileStats.reduce((s, f) => s + f.deletions, 0);
      this._summaryData = {
        type: 'showSummary',
        prTitle: plan.prTitle,
        summary: plan.summary,
        modelName: this._modelName,
        contextLabel: this._contextLabel,
        totalFiles: this._allFiles.length,
        allFiles: this._allFiles,
        fileStats: this._fileStats,
        totalAdditions,
        totalDeletions,
        fromBranch: this._fromBranch,
        toBranch: this._toBranch,
        stepTitles: plan.steps.map(s => s.title),
        hasPRInfo: !!(this._prOwner && this._prRepo && this._prNumber),
      };
      this._postSummary();
      this._saveSession(-1);
    } catch (err: any) {
      if (!cts.token.isCancellationRequested) {
        this._post({ type: 'error', message: err.message ?? String(err) });
      }
    }
  }

  private async _showCurrentStep(): Promise<void> {
    if (!this._plan) return;
    const step = this._plan.steps[this._stepIndex];
    const fileCoverage = buildFileCoverage(this._plan.steps);

    this._post({
      type: 'showStep',
      step,
      index: this._stepIndex,
      total: this._plan.steps.length,
      prTitle: this._plan.prTitle,
      modelName: this._modelName,
      contextLabel: this._contextLabel,
      allFiles: this._allFiles,
      fileCoverage,
      stepTitles: this._plan.steps.map(s => s.title),
      completedSteps: [...this._completedSteps],
    });

    // Open the file containing the first section and highlight its range
    const firstSection = step.sections[0];
    if (firstSection) {
      await this._openAndHighlight(firstSection.filename, {
        start: firstSection.startLine,
        end: firstSection.endLine,
      });
    }
  }

  private _clearDecorations(): void {
    this._decorations.forEach(d => d.dispose());
    this._decorations = [];
  }

  private async _openAndHighlight(
    filename: string,
    range?: { start: number; end: number },
  ): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return;

    for (const folder of folders) {
      const uri = vscode.Uri.joinPath(folder.uri, filename);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          preview: true,
          preserveFocus: true,
          viewColumn: vscode.ViewColumn.One,
        });

        this._clearDecorations();
        const decoration = vscode.window.createTextEditorDecorationType({
          backgroundColor: 'rgba(255, 190, 0, 0.18)',
          borderWidth: '0 0 0 3px',
          borderStyle: 'solid',
          borderColor: 'rgba(255, 160, 0, 0.75)',
          isWholeLine: true,
        });
        this._decorations.push(decoration);

        if (range) {
          const startLine = Math.max(0, range.start - 1);
          const endLine = Math.max(startLine, range.end - 1);
          const vscRange = new vscode.Range(startLine, 0, endLine, 9999);
          const targets = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === doc.uri.toString());
          for (const e of targets) {
            e.setDecorations(decoration, [vscRange]);
            e.revealRange(vscRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          }
        }
        return;
      } catch {
        // not in this folder, try next
      }
    }
  }

  private async _openAndHighlightMultiple(
    sections: Array<{ filename: string; startLine: number; endLine: number; color: string }>,
    jumpToFilename?: string,
    jumpToLine?: number,
  ): Promise<void> {
    if (!sections.length) return;
    this._clearDecorations();

    const targetFilename = jumpToFilename ?? sections[0].filename;
    const fileSections = sections.filter(s => s.filename === targetFilename);
    const jumpSection = (jumpToLine != null
      ? fileSections.find(s => s.startLine === jumpToLine)
      : undefined) ?? fileSections[0] ?? sections[0];

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return;

    for (const folder of folders) {
      const uri = vscode.Uri.joinPath(folder.uri, targetFilename);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          preview: true,
          preserveFocus: true,
          viewColumn: vscode.ViewColumn.One,
        });

        const editors = vscode.window.visibleTextEditors.filter(
          e => e.document.uri.toString() === doc.uri.toString(),
        );

        for (const sec of fileSections) {
          const [r, g, b] = hexToRgb(sec.color);
          const deco = vscode.window.createTextEditorDecorationType({
            backgroundColor: `rgba(${r},${g},${b},0.18)`,
            borderWidth: '0 0 0 3px',
            borderStyle: 'solid',
            borderColor: sec.color,
            isWholeLine: true,
          });
          this._decorations.push(deco);

          const startLine = Math.max(0, sec.startLine - 1);
          const endLine = Math.max(startLine, sec.endLine - 1);
          const range = new vscode.Range(startLine, 0, endLine, 9999);
          for (const e of editors) {
            e.setDecorations(deco, [range]);
          }
        }

        // Reveal the jump target
        const startLine = Math.max(0, jumpSection.startLine - 1);
        const endLine = Math.max(startLine, jumpSection.endLine - 1);
        const revealRange = new vscode.Range(startLine, 0, endLine, 9999);
        for (const e of editors) {
          e.revealRange(revealRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        return;
      } catch {
        // try next folder
      }
    }
  }

  private async _handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'webviewReady':
        this._checkSavedSession();
        break;

      case 'resumeSession': {
        const session = this._context.workspaceState.get<SavedSession>('elig.session');
        if (!session?.plan) break;
        this._plan = session.plan;
        this._stepIndex = Math.max(0, session.stepIndex);
        this._contextLabel = session.contextLabel ?? '';
        this._allFiles = session.allFiles ?? [];
        this._fileStats = session.fileStats ?? [];
        this._modelName = session.modelName ?? '';
        this._fromBranch = session.fromBranch ?? '';
        this._toBranch = session.toBranch ?? '';
        this._completedSteps = new Set(session.completedSteps ?? []);
        this._prOwner = session.prOwner ?? '';
        this._prRepo = session.prRepo ?? '';
        this._prNumber = session.prNumber ?? 0;
        const totalAdditions = this._fileStats.reduce((s, f) => s + f.additions, 0);
        const totalDeletions = this._fileStats.reduce((s, f) => s + f.deletions, 0);
        this._summaryData = {
          type: 'showSummary',
          prTitle: this._plan.prTitle,
          summary: this._plan.summary,
          modelName: this._modelName,
          contextLabel: this._contextLabel,
          totalFiles: this._allFiles.length,
          allFiles: this._allFiles,
          fileStats: this._fileStats,
          totalAdditions,
          totalDeletions,
          stepTitles: this._plan.steps.map(s => s.title),
          hasPRInfo: !!(this._prOwner && this._prRepo && this._prNumber),
        };
        if (session.stepIndex < 0) {
          this._postSummary();
        } else {
          await this._showCurrentStep();
        }
        break;
      }

      case 'discardSession':
        this._context.workspaceState.update('elig.session', undefined);
        break;

      case 'runCommand':
        if (typeof msg.command === 'string') {
          vscode.commands.executeCommand(msg.command);
        }
        break;

      case 'startLesson':
        await this._showCurrentStep();
        this._saveSession(this._stepIndex);
        break;

      case 'goToSummary':
        if (this._summaryData) {
          this._postSummary();
          this._saveSession(-1);
        }
        break;

      case 'goToStep': {
        const idx = msg.index as number | undefined;
        if (this._plan && idx != null && idx >= 0 && idx < this._plan.steps.length) {
          this._stepIndex = idx;
          await this._showCurrentStep();
          this._saveSession(this._stepIndex);
        }
        break;
      }

      case 'nextStep':
        if (this._plan && this._stepIndex < this._plan.steps.length - 1) {
          this._completedSteps.add(this._stepIndex);
          this._stepIndex++;
          await this._showCurrentStep();
          this._saveSession(this._stepIndex);
        }
        break;

      case 'prevStep':
        if (this._stepIndex > 0) {
          this._stepIndex--;
          await this._showCurrentStep();
          this._saveSession(this._stepIndex);
        }
        break;

      case 'openFile': {
        const filename = msg.filename as string | undefined;
        const startLine = msg.startLine as number | undefined;
        const endLine = msg.endLine as number | undefined;
        if (filename) {
          await this._openAndHighlight(
            filename,
            startLine != null && endLine != null ? { start: startLine, end: endLine } : undefined,
          );
        }
        break;
      }

      case 'openSections': {
        const sections = msg.sections as Array<{ filename: string; startLine: number; endLine: number; color: string }> | undefined;
        const jumpToFilename = msg.jumpToFilename as string | undefined;
        const jumpToLine = msg.jumpToLine as number | undefined;
        if (sections?.length) {
          await this._openAndHighlightMultiple(sections, jumpToFilename, jumpToLine);
        }
        break;
      }

      case 'dumberPlease':
      case 'rephrase':
      case 'reviewMode':
      case 'learnMode': {
        if (!this._plan) break;
        const step: LessonStep = this._plan.steps[this._stepIndex];
        const mode = msg.type === 'dumberPlease' ? 'dumber'
          : msg.type === 'rephrase' ? 'rephrase'
          : msg.type === 'reviewMode' ? 'review'
          : 'learn';
        let model: vscode.LanguageModelChat;
        try {
          model = await selectModel();
        } catch (err: any) {
          this._post({ type: 'streamError', text: err.message ?? String(err) });
          break;
        }
        const cts = new vscode.CancellationTokenSource();
        this._post({ type: 'streamStart' });
        let newText = '';
        try {
          await reexplain(step, mode, model, chunk => {
            newText += chunk;
            this._post({ type: 'streamChunk', text: chunk });
          }, cts.token);
          if (newText) step.explanation = newText;
        } catch (err: any) {
          this._post({ type: 'streamError', text: err.message ?? String(err) });
        } finally {
          this._post({ type: 'streamDone' });
          cts.dispose();
        }
        break;
      }

      case 'askGrug': {
        if (!this._plan) break;
        const question = msg.question as string | undefined;
        if (!question?.trim()) break;
        const step: LessonStep = this._plan.steps[this._stepIndex];
        let model: vscode.LanguageModelChat;
        try {
          model = await selectModel();
        } catch (err: any) {
          this._post({ type: 'streamError', text: err.message ?? String(err) });
          break;
        }
        const cts = new vscode.CancellationTokenSource();
        this._post({ type: 'askStart' });
        try {
          await askQuestion(step, question, model, chunk => {
            this._post({ type: 'askChunk', text: chunk });
          }, cts.token);
        } catch (err: any) {
          this._post({ type: 'askError', text: err.message ?? String(err) });
        } finally {
          this._post({ type: 'askDone' });
          cts.dispose();
        }
        break;
      }

      case 'showDiffInEditor': {
        const filename  = msg.filename  as string | undefined;
        const startLine = (msg.startLine as number | undefined) ?? 1;
        const endLine   = (msg.endLine   as number | undefined) ?? startLine;
        if (!filename) break;

        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) break;
        const workspaceRoot = folders[0].uri.fsPath;

        // Resolve the base ref to compare against:
        //   branch mode  — _diffBase is the resolved base branch (e.g. 'main')
        //   PR mode      — _diffBase is 'HEAD', but _toBranch has the target branch
        //   local changes — _diffBase is 'HEAD', _toBranch is ''
        const isLocalChanges = this._diffBase === 'HEAD' && !this._toBranch;
        const effectiveBase  = this._diffBase !== 'HEAD' ? this._diffBase : this._toBranch;

        function gitShow(ref: string, file: string): string {
          return execSync(`git show "${ref}:${file}"`, {
            cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
          });
        }

        // Build rawDiff for hunk extraction (only needed for step-level diffs)
        let rawDiff = '';
        if (effectiveBase) {
          for (const range of [`${effectiveBase}..HEAD`, `origin/${effectiveBase}..HEAD`]) {
            try {
              rawDiff = execSync(`git diff -U20 "${range}" -- "${filename}"`, {
                cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
              });
              if (rawDiff) break;
            } catch { /* try next */ }
          }
        } else if (isLocalChanges) {
          try {
            rawDiff = execSync(`git diff -U20 HEAD -- "${filename}"`, {
              cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
            });
          } catch { /* nothing */ }
        }

        const fullFile = startLine === 0 && endLine === 0;
        const hunk = rawDiff && !fullFile ? extractHunkForLine(rawDiff, startLine, endLine) : null;

        const id  = Date.now().toString(36);
        const ext = filename.split('.').pop() || 'txt';

        let beforeContent = '';
        let afterContent  = '';

        if (hunk) {
          beforeContent = hunk.before;
          afterContent  = hunk.after;
        } else {
          // before: file at base ref (try direct name, then origin/ prefix)
          if (isLocalChanges) {
            try { beforeContent = gitShow('HEAD', filename); } catch { /* new file */ }
          } else if (effectiveBase) {
            for (const ref of [effectiveBase, `origin/${effectiveBase}`]) {
              try { beforeContent = gitShow(ref, filename); break; } catch { /* try next */ }
            }
          }

          // after: HEAD for branch/PR mode, working tree for local changes
          if (isLocalChanges) {
            try {
              afterContent = require('fs').readFileSync(
                require('path').join(workspaceRoot, filename), 'utf8',
              );
            } catch { /* deleted file */ }
          } else {
            try { afterContent = gitShow('HEAD', filename); } catch { /* new file */ }
          }
        }

        const beforeKey = `before-${id}.${ext}`;
        const afterKey  = `after-${id}.${ext}`;
        this._diffProvider.set(beforeKey, beforeContent);
        this._diffProvider.set(afterKey,  afterContent);

        const beforeUri = vscode.Uri.parse(`elig-diff:/${beforeKey}`);
        const afterUri  = vscode.Uri.parse(`elig-diff:/${afterKey}`);
        const shortName = filename.split('/').pop() ?? filename;
        const baseLabel = isLocalChanges ? 'HEAD' : (effectiveBase || 'base');
        const afterLabel = isLocalChanges ? 'working' : 'HEAD';

        await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri,
          `ELIG: ${shortName} (${baseLabel} ↔ ${afterLabel})`, {
            preview: true,
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Range(Math.max(0, startLine - 1), 0, Math.max(0, startLine - 1), 0),
          });
        break;
      }

      case 'expandPart': {
        if (!this._plan) break;
        const partIndex = msg.partIndex as number;
        const partText = msg.partText as string | undefined;
        const partRefs = msg.partRefs as number[] | undefined;
        if (!partText?.trim()) break;
        const step: LessonStep = this._plan.steps[this._stepIndex];
        let model: vscode.LanguageModelChat;
        try {
          model = await selectModel();
        } catch (err: any) {
          this._post({ type: 'expandError', partIndex, text: err.message ?? String(err) });
          break;
        }
        const cts = new vscode.CancellationTokenSource();
        this._post({ type: 'expandStart', partIndex });
        try {
          await expandExplanation(step, partText, partRefs ?? [], model, chunk => {
            this._post({ type: 'expandChunk', partIndex, text: chunk });
          }, cts.token);
        } catch (err: any) {
          this._post({ type: 'expandError', partIndex, text: err.message ?? String(err) });
        } finally {
          this._post({ type: 'expandDone', partIndex });
          cts.dispose();
        }
        break;
      }

      case 'reanalyze': {
        if (!this._diffFiles.length) break;
        const cts2 = new vscode.CancellationTokenSource();
        await this._doLoad(this._diffFiles, cts2);
        cts2.dispose();
        break;
      }

      case 'exportLesson': {
        if (!this._plan) break;
        const plan = this._plan;
        const exportData = {
          prTitle: plan.prTitle,
          summary: plan.summary,
          steps: plan.steps,
          contextLabel: this._contextLabel,
          allFiles: this._allFiles,
          fileStats: this._fileStats,
          totalAdditions: this._fileStats.reduce((s, f) => s + f.additions, 0),
          totalDeletions: this._fileStats.reduce((s, f) => s + f.deletions, 0),
          fromBranch: this._fromBranch,
          toBranch: this._toBranch,
        };
        let md = `<!-- ELIG_DATA:${JSON.stringify(exportData)} -->\n\n`;
        md += `# ${plan.prTitle}\n\n`;
        if (this._contextLabel) md += `${this._contextLabel}\n\n`;
        md += `## Summary\n\n${plan.summary}\n\n---\n\n`;
        plan.steps.forEach((s, i) => {
          const fileRefs = s.sections.map(sec => `${sec.filename}:${sec.startLine}-${sec.endLine} (${sec.label ?? ''})`).join(', ');
          md += `## Step ${i + 1}: ${s.title}\n\n`;
          if (fileRefs) md += `**Files:** ${fileRefs}\n\n`;
          md += `${s.explanation}\n\n---\n\n`;
        });
        const saveUri = await vscode.window.showSaveDialog({
          filters: { Markdown: ['md'] },
          defaultUri: vscode.Uri.file('lesson.md'),
        });
        if (saveUri) {
          require('fs').writeFileSync(saveUri.fsPath, md, 'utf8');
          vscode.window.showInformationMessage(`ELIG: Lesson exported to ${saveUri.fsPath}`);
        }
        break;
      }

      case 'importLesson': {
        const uris = await vscode.window.showOpenDialog({
          filters: { Markdown: ['md'] },
          canSelectMany: false,
        });
        if (!uris?.length) break;
        const content = require('fs').readFileSync(uris[0].fsPath, 'utf8') as string;
        const match = content.match(/<!--\s*ELIG_DATA:([\s\S]*?)-->/);
        if (!match) {
          vscode.window.showErrorMessage('ELIG: No ELIG_DATA found in this file.');
          break;
        }
        let imported: {
          prTitle: string; summary: string; steps: LessonStep[];
          contextLabel?: string; allFiles?: string[]; fileStats?: FileStat[];
          totalAdditions?: number; totalDeletions?: number;
          fromBranch?: string; toBranch?: string;
        };
        try {
          imported = JSON.parse(match[1]);
        } catch {
          vscode.window.showErrorMessage('ELIG: Could not parse ELIG_DATA JSON.');
          break;
        }
        this._plan = { prTitle: imported.prTitle, summary: imported.summary, steps: imported.steps };
        this._contextLabel = imported.contextLabel ?? '';
        this._allFiles = imported.allFiles ?? [];
        this._fileStats = imported.fileStats ?? [];
        this._fromBranch = imported.fromBranch ?? '';
        this._toBranch = imported.toBranch ?? '';
        this._modelName = '';
        this._completedSteps = new Set<number>();
        this._stepIndex = 0;
        this._prOwner = '';
        this._prRepo = '';
        this._prNumber = 0;
        const impAdditions = imported.totalAdditions ?? this._fileStats.reduce((s, f) => s + f.additions, 0);
        const impDeletions = imported.totalDeletions ?? this._fileStats.reduce((s, f) => s + f.deletions, 0);
        this._summaryData = {
          type: 'showSummary',
          prTitle: this._plan.prTitle,
          summary: this._plan.summary,
          modelName: this._modelName,
          contextLabel: this._contextLabel,
          totalFiles: this._allFiles.length,
          allFiles: this._allFiles,
          fileStats: this._fileStats,
          totalAdditions: impAdditions,
          totalDeletions: impDeletions,
          fromBranch: this._fromBranch,
          toBranch: this._toBranch,
          stepTitles: this._plan.steps.map(s => s.title),
          hasPRInfo: false,
        };
        this._postSummary();
        this._saveSession(-1);
        break;
      }

      case 'postPRComment': {
        const token = vscode.workspace.getConfiguration('elig').get<string>('githubToken', '');
        const plan = this._plan;
        if (!plan) break;
        let commentMd = `## ${plan.prTitle}\n\n${plan.summary}\n\n`;
        plan.steps.forEach((s, i) => {
          commentMd += `### Step ${i + 1}: ${s.title}\n\n${s.explanation}\n\n`;
        });
        if (this._allFiles.length) {
          commentMd += `**Files changed:** ${this._allFiles.join(', ')}\n`;
        }
        try {
          const headers: Record<string, string> = {
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          };
          if (token) headers['Authorization'] = `Bearer ${token}`;
          const response = await fetch(
            `https://api.github.com/repos/${this._prOwner}/${this._prRepo}/issues/${this._prNumber}/comments`,
            { method: 'POST', headers, body: JSON.stringify({ body: commentMd }) },
          );
          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`GitHub API error ${response.status}: ${errText}`);
          }
          this._post({ type: 'prCommentPosted' });
        } catch (err: any) {
          this._post({ type: 'prCommentError', message: err.message ?? String(err) });
        }
        break;
      }
    }
  }

  private _post(msg: object): void {
    this._view?.webview.postMessage(msg);
  }

  private _postSummary(): void {
    if (!this._summaryData) return;
    this._post({ ...(this._summaryData as Record<string, unknown>), completedSteps: [...this._completedSteps] });
  }

  private _buildHtml(webview: vscode.Webview): string {
    const pkg = JSON.parse(
      require('fs').readFileSync(
        vscode.Uri.joinPath(this._extensionUri, 'package.json').fsPath,
        'utf8',
      ),
    ) as { version: string };
    const version = pkg.version ?? '?';
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'panel.css'),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'panel.js'),
    );
    const cavemanUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'caveman.png'),
    );
    const cavemanStrikeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'caveman-strike.png'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>ELIG</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.ELIG_VERSION = '${version}';
    window.ELIG_MEDIA = { cavemanUp: '${cavemanUri}', cavemanDown: '${cavemanStrikeUri}' };
  </script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function extractHunkForLine(
  rawDiff: string,
  targetStart: number,
  targetEnd: number,
): { before: string; after: string } | null {
  const lines = rawDiff.split('\n');

  // Collect all hunks as { newStart, newEnd, lines[] }
  const hunks: { newStart: number; newEnd: number; lines: string[] }[] = [];
  let current: { newStart: number; newEnd: number; lines: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      if (current) hunks.push(current);
      const start = parseInt(m[1]);
      const count = parseInt(m[2] ?? '1');
      current = { newStart: start, newEnd: start + Math.max(0, count - 1), lines: [] };
    } else if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);

  // Find the hunk whose range overlaps the target section (allow 5-line slop)
  const hunk = hunks.find(h =>
    h.newStart <= targetEnd + 5 && h.newEnd >= targetStart - 5,
  );
  if (!hunk) return null;

  // Build before/after from the hunk lines
  const beforeLines: string[] = [];
  const afterLines: string[]  = [];
  for (const line of hunk.lines) {
    if (line.startsWith(' ')) {
      beforeLines.push(line.slice(1));
      afterLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      beforeLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      afterLines.push(line.slice(1));
    }
  }

  // Pad top with empty lines so real line numbers show in the diff editor
  const pad = new Array(Math.max(0, hunk.newStart - 1)).fill('');
  return {
    before: [...pad, ...beforeLines].join('\n'),
    after:  [...pad, ...afterLines].join('\n'),
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
