# ELIG: Explain Like I'm Grug

**ELIG** turns a PR or branch diff into an interactive, plain-English lesson inside VS Code. Step through your changes one concept at a time, with the relevant code highlighted in the editor as you go. Ask follow-up questions, request simpler explanations, or rephrase on demand.

Built for developers who want to actually understand a diff — not just skim it.

![ELIG in action](https://raw.githubusercontent.com/bitcoin-coder-bob/GrugReviews/master/media/screenshot.png)

---

## How it works

1. Open a repo in VS Code
2. Click the ELIG icon in the activity bar (the caveman)
3. Hit **Grug this Branch**, **Grug Local Changes**, or **Grug a PR**
4. ELIG analyzes the diff using whatever AI you have installed (GitHub Copilot, Claude, etc.) and generates a step-by-step lesson
5. Walk through each step — the relevant file opens and the changed lines are highlighted automatically

---

## Features

### Diff sources
- **Branch diff**: analyzes everything between your current branch and the base branch
- **Local changes**: analyzes your uncommitted changes against HEAD
- **PR diff**: paste a GitHub PR URL or number to review any PR

### Lesson overview
- **Summary screen**: shows the PR title, plain-English overview, branch names with `+N/-N` stats, all changed files, and every lesson step
- **Clickable files**: click any file in the summary to open a side-by-side diff for that file directly
- **Step completion marks**: steps you have navigated through show a `✓` in the summary and step counter
- **Jump to any step**: click a step in the summary, or use the dropdown nav on any step screen

### Step view
- **Color-coded sections**: each file section in a step gets a neon color; explanation paragraphs have matching colored borders so you always know which text maps to which code
- **Breadcrumb**: a row of file chips at the top of each step shows which files are in scope; click one to jump to it in the editor
- **File highlights**: relevant lines highlighted in amber as you read each step
- **Hover to highlight**: hover over any explanation paragraph to pop the matching file sections; unrelated sections dim, referenced ones light up
- **Click to lock**: click a paragraph to keep its sections highlighted while you read; click again to release
- **Jump chips**: each explanation paragraph shows file+line chips on hover; click to jump to that section in the editor
- **Diff view**: each section chip has a `⊞` zone; click it to open a VS Code diff editor scoped to just that section
- **More detail**: expand any explanation paragraph to get a deeper dive on that specific part
- **Confidence indicator**: a warning badge appears when the AI flags that intent is unclear or context is missing
- **Files changed panel**: collapsible panel showing every changed file with status (current, explained, upcoming)
- **Scroll position memory**: returning to a step restores exactly where you were in the explanation

### Explanation modes
- **Explain dumber**: one click for a simpler explanation aimed at someone just learning to code
- **Rephrase**: a completely different take on the same concept
- **What changed**: reviewer lens — what changed, why, and any trade-offs
- **Explain code**: learner lens — what the code conceptually does and how it works

### Ask Grug
- Type any question about the current step and get a plain-English answer streamed directly into the panel
- Answers persist when you leave the step and come back
- Retry button appears if the request fails

### Keyboard shortcuts
| Key | Action |
|-----|--------|
| `→` | Next step |
| `←` | Back / summary |
| `/` | Focus the Ask Grug input |
| `Esc` | Dismiss input |

Press `?` in the step view to show/hide the shortcut reference.

### Export, import, and sharing
- **Export as .md**: save the full lesson as a Markdown file — human-readable, and importable back into ELIG
- **Import lesson**: open any previously exported `.md` file to restore the full lesson without re-running AI
- **Post to GitHub**: post the lesson summary as a comment directly on the GitHub PR (requires `elig.githubToken` for private repos)
- **Re-analyze**: re-run the AI analysis on the same diff for a fresh take, without re-fetching the diff

### Reliability
- **Session resume**: close VS Code and reopen — ELIG remembers your last session and drops you back where you left off
- **Restart session**: hit `↺` at any time to discard the current session and start fresh
- **Error retry**: if an AI call fails, a retry button appears in place so you do not have to start over
- **Progress labels**: while re-explaining or asking, a label shows what operation is running

### AI
- **Works with any AI**: uses the VS Code Language Model API — no separate API key needed; compatible with GitHub Copilot, Claude for VS Code, and any other LM extension

---

## Requirements

You need at least one language model installed in VS Code. Either of these works:

- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)
- [Claude for VS Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-vscode)

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `elig.baseRef` | `main` | Base branch to diff against for **Grug this Branch** |
| `elig.githubToken` | _(empty)_ | GitHub PAT for private repo PR diffs and posting PR comments |

---

## Commands

All commands are also available as buttons in the ELIG sidebar panel.

| Command | Description |
|---|---|
| `ELIG: Grug this Branch` | Analyze current branch vs base |
| `ELIG: Grug Local Changes` | Analyze uncommitted local changes |
| `ELIG: Grug a PR` | Analyze a GitHub PR by URL or number |

---

## License

MIT. See [LICENSE](LICENSE).
