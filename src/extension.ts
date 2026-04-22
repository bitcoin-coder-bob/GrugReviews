import * as vscode from 'vscode';
import { EligPanelProvider } from './eligPanelProvider';
import { fetchBranchDiff, fetchPRDiff, detectGitHubRemote, getCurrentBranch, resolveBaseRef } from './diffFetcher';

export const outputChannel = vscode.window.createOutputChannel('ELIG');

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(outputChannel);
  const provider = new EligPanelProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EligPanelProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('elig.grugBranch', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('ELIG: No workspace folder open.');
        return;
      }

      const config = vscode.workspace.getConfiguration('elig');
      const baseRef = config.get<string>('baseRef', 'main');

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `ELIG: Analyzing changes vs ${baseRef}...`,
          cancellable: true,
        },
        async (_progress, cancelToken) => {
          const cts = new vscode.CancellationTokenSource();
          cancelToken.onCancellationRequested(() => cts.cancel());

          try {
            const resolvedBase = resolveBaseRef(workspaceRoot, baseRef);
            const currentBranch = getCurrentBranch(workspaceRoot);
            const contextLabel = `${currentBranch} → ${resolvedBase}`;
            const diffFiles = fetchBranchDiff(workspaceRoot, baseRef);
            if (diffFiles.length === 0) {
              vscode.window.showInformationMessage(`ELIG: No changes found vs '${baseRef}'.`);
              return;
            }
            await provider.loadLesson(diffFiles, cts, contextLabel);
          } catch (err: any) {
            vscode.window.showErrorMessage(`ELIG: ${err.message ?? String(err)}`);
          } finally {
            cts.dispose();
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('elig.grugPR', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter GitHub PR URL or PR number',
        placeHolder: 'https://github.com/owner/repo/pull/123   or   42',
        validateInput: val => {
          if (!val?.trim()) return 'Please enter a PR URL or number';
          return undefined;
        },
      });
      if (!input) return;

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const config = vscode.workspace.getConfiguration('elig');
      const token = config.get<string>('githubToken', '') || undefined;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ELIG: Fetching PR diff...',
          cancellable: true,
        },
        async (_progress, cancelToken) => {
          const cts = new vscode.CancellationTokenSource();
          cancelToken.onCancellationRequested(() => cts.cancel());

          try {
            let owner: string;
            let repo: string;
            let prNumber: number;

            const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
            if (urlMatch) {
              owner = urlMatch[1];
              repo = urlMatch[2];
              prNumber = parseInt(urlMatch[3], 10);
            } else if (/^\d+$/.test(input.trim())) {
              prNumber = parseInt(input.trim(), 10);
              const remote = workspaceRoot ? detectGitHubRemote(workspaceRoot) : undefined;
              if (!remote) {
                vscode.window.showErrorMessage(
                  'ELIG: Could not detect GitHub remote from git config. Use a full PR URL instead.',
                );
                return;
              }
              ({ owner, repo } = remote);
            } else {
              vscode.window.showErrorMessage(
                'ELIG: Invalid input. Enter a GitHub PR URL or a PR number.',
              );
              return;
            }

            const diffFiles = await fetchPRDiff(owner, repo, prNumber, token);
            if (diffFiles.length === 0) {
              vscode.window.showInformationMessage('ELIG: This PR has no changed files.');
              return;
            }
            const contextLabel = `PR #${prNumber} — ${owner}/${repo}`;
            await provider.loadLesson(diffFiles, cts, contextLabel);
          } catch (err: any) {
            vscode.window.showErrorMessage(`ELIG: ${err.message ?? String(err)}`);
          } finally {
            cts.dispose();
          }
        },
      );
    }),
  );
}

export function deactivate(): void {}
