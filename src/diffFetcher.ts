import { execSync } from 'child_process';
import { DiffFile, DiffHunk } from './types';

export function detectGitHubRemote(repoPath: string): { owner: string; repo: string } | undefined {
  try {
    const remote = execSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf8' }).trim();
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  } catch {}
  return undefined;
}

export function resolveBaseRef(repoPath: string, configured: string): string {
  try {
    execSync(`git rev-parse --verify ${configured}`, { cwd: repoPath, stdio: 'pipe' });
    return configured;
  } catch {}

  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    return ref.replace('refs/remotes/origin/', '');
  } catch {}

  for (const candidate of ['master', 'develop', 'trunk']) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, { cwd: repoPath, stdio: 'pipe' });
      return candidate;
    } catch {}
  }

  throw new Error(
    `Could not find base branch '${configured}'. Set elig.baseRef in VS Code settings to your repo's default branch (e.g. "master").`,
  );
}

export function getCurrentBranch(repoPath: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
  } catch {
    return 'HEAD';
  }
}

export function fetchBranchDiff(repoPath: string, baseRef: string): DiffFile[] {
  const resolved = resolveBaseRef(repoPath, baseRef);
  let raw: string;
  try {
    raw = execSync(`git diff ${resolved}...HEAD`, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e: any) {
    throw new Error(`git diff failed against '${resolved}': ${e.message}`);
  }
  if (!raw.trim()) return [];
  return parseDiff(raw);
}

export function fetchLocalDiff(repoPath: string): DiffFile[] {
  let raw: string;
  try {
    // git diff HEAD captures all uncommitted changes — both staged and unstaged
    raw = execSync('git diff HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e: any) {
    throw new Error(`git diff HEAD failed: ${e.message}`);
  }
  if (!raw.trim()) return [];
  return parseDiff(raw);
}

export async function fetchPRBranches(
  owner: string,
  repo: string,
  prNumber: number,
  token?: string,
): Promise<{ headRef: string; baseRef: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'vscode-elig',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
  if (!response.ok) return { headRef: '', baseRef: '' };
  const pr = (await response.json()) as any;
  return { headRef: pr.head?.ref ?? '', baseRef: pr.base?.ref ?? '' };
}

export async function fetchPRDiff(
  owner: string,
  repo: string,
  prNumber: number,
  token?: string,
): Promise<DiffFile[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'vscode-elig',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub API error ${response.status}: ${body || response.statusText}`);
  }

  const files = (await response.json()) as any[];
  return files.map(f => ({
    filename: f.filename as string,
    patch: (f.patch as string) ?? '',
    status: f.status as string,
    additions: f.additions as number,
    deletions: f.deletions as number,
    hunks: parseHunks((f.patch as string) ?? ''),
  }));
}

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = raw.split(/^diff --git /m).slice(1);

  for (const chunk of chunks) {
    const filenameMatch = chunk.match(/^a\/.+ b\/(.+)\n/);
    if (!filenameMatch) continue;
    const filename = filenameMatch[1].trim();

    let status = 'modified';
    if (chunk.includes('\nnew file mode')) status = 'added';
    else if (chunk.includes('\ndeleted file mode')) status = 'removed';
    else if (chunk.includes('\nrename to ')) status = 'renamed';

    const additions = (chunk.match(/^\+[^+]/gm) ?? []).length;
    const deletions = (chunk.match(/^-[^-]/gm) ?? []).length;

    files.push({
      filename,
      patch: chunk,
      status,
      additions,
      deletions,
      hunks: parseHunks(chunk),
    });
  }

  return files;
}

export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  // Split on @@ boundaries, keeping the @@ delimiter
  const parts = patch.split(/(?=^@@)/m);

  for (const part of parts) {
    const header = part.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)/);
    if (!header) continue;

    const newStart = parseInt(header[1]);
    const newCount = parseInt(header[2] ?? '1');
    const context = header[3].trim();
    const newEnd = newStart + Math.max(0, newCount - 1);

    // Collect +/- lines for prompt context (skip the @@ header line itself)
    const lines = part
      .split('\n')
      .slice(1)
      .filter(l => l.startsWith('+') || l.startsWith('-'))
      .slice(0, 20);

    hunks.push({ newStart, newEnd, context, lines });
  }

  return hunks;
}
