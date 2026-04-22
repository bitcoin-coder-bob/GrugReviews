import * as vscode from 'vscode';
import { DiffFile, LessonPlan, LessonStep } from './types';
import {
  generateLessonPlan,
  reexplain,
  askQuestion,
  selectModel,
  modelDisplayName,
  stepFilenames,
  buildFileCoverage,
} from './lessonGenerator';

export class EligPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'elig.lessonPanel';

  private _view?: vscode.WebviewView;
  private _plan?: LessonPlan;
  private _allFiles: string[] = [];
  private _stepIndex = 0;
  private _modelName = '';
  private _contextLabel = '';
  private _summaryData?: object;
  private _decoration?: vscode.TextEditorDecorationType;
  private _pendingLoad?: { diffFiles: DiffFile[]; cts: vscode.CancellationTokenSource };

  constructor(private readonly _extensionUri: vscode.Uri) {}

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
  }

  async loadLesson(diffFiles: DiffFile[], cts: vscode.CancellationTokenSource, contextLabel = ''): Promise<void> {
    this._contextLabel = contextLabel;
    await vscode.commands.executeCommand('elig.lessonPanel.focus');

    if (!this._view) {
      this._pendingLoad = { diffFiles, cts };
      return;
    }

    await this._doLoad(diffFiles, cts);
  }

  private async _doLoad(diffFiles: DiffFile[], cts: vscode.CancellationTokenSource): Promise<void> {
    this._allFiles = diffFiles.map(f => f.filename);

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
      this._summaryData = {
        type: 'showSummary',
        prTitle: plan.prTitle,
        summary: plan.summary,
        modelName: this._modelName,
        contextLabel: this._contextLabel,
        totalFiles: this._allFiles.length,
        allFiles: this._allFiles,
        stepTitles: plan.steps.map(s => s.title),
      };
      this._post(this._summaryData);
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
        const editor = await vscode.window.showTextDocument(doc, {
          preview: true,
          preserveFocus: true,
          viewColumn: vscode.ViewColumn.One,
        });

        this._decoration?.dispose();
        this._decoration = vscode.window.createTextEditorDecorationType({
          backgroundColor: 'rgba(255, 190, 0, 0.18)',
          borderWidth: '0 0 0 3px',
          borderStyle: 'solid',
          borderColor: 'rgba(255, 160, 0, 0.75)',
          isWholeLine: true,
        });

        if (range) {
          const startLine = Math.max(0, range.start - 1);
          const endLine = Math.max(startLine, range.end - 1);
          // Use a large end column so the range always covers the full last line
          const vscRange = new vscode.Range(startLine, 0, endLine, 9999);
          editor.setDecorations(this._decoration, [vscRange]);
          editor.revealRange(vscRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        return;
      } catch {
        // not in this folder, try next
      }
    }
  }

  private async _handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'runCommand':
        if (typeof msg.command === 'string') {
          vscode.commands.executeCommand(msg.command);
        }
        break;

      case 'startLesson':
        await this._showCurrentStep();
        break;

      case 'goToSummary':
        if (this._summaryData) this._post(this._summaryData);
        break;

      case 'goToStep': {
        const idx = msg.index as number | undefined;
        if (this._plan && idx != null && idx >= 0 && idx < this._plan.steps.length) {
          this._stepIndex = idx;
          await this._showCurrentStep();
        }
        break;
      }

      case 'nextStep':
        if (this._plan && this._stepIndex < this._plan.steps.length - 1) {
          this._stepIndex++;
          await this._showCurrentStep();
        }
        break;

      case 'prevStep':
        if (this._stepIndex > 0) {
          this._stepIndex--;
          await this._showCurrentStep();
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

      case 'dumberPlease':
      case 'rephrase': {
        if (!this._plan) break;
        const step: LessonStep = this._plan.steps[this._stepIndex];
        const mode = msg.type === 'dumberPlease' ? 'dumber' : 'rephrase';
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
        this._post({ type: 'streamStart' });
        try {
          await askQuestion(step, question, model, chunk => {
            this._post({ type: 'streamChunk', text: chunk });
          }, cts.token);
        } catch (err: any) {
          this._post({ type: 'streamError', text: err.message ?? String(err) });
        } finally {
          this._post({ type: 'streamDone' });
          cts.dispose();
        }
        break;
      }
    }
  }

  private _post(msg: object): void {
    this._view?.webview.postMessage(msg);
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
    const csp = [
      `default-src 'none'`,
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
  <script nonce="${nonce}">window.ELIG_VERSION = '${version}';</script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
