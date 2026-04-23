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

- **Branch diff**: analyzes everything between your current branch and the base branch
- **Local changes**: analyzes your uncommitted changes against HEAD
- **PR diff**: paste a GitHub PR URL or number to review any PR
- **Step-by-step lessons**: changes grouped into logical concepts, ordered from foundational to dependent
- **File highlights**: relevant lines highlighted in amber as you read each step
- **Color-coded sections**: each file section in a step gets a neon color; explanation paragraphs have matching colored borders so you always know which text maps to which file
- **Hover to highlight**: hover over any explanation paragraph to pop the matching file sections — unrelated sections dim, referenced ones light up and slide forward
- **Click to lock**: click a paragraph to keep its sections highlighted while you read; click again to release
- **Jump chips**: each explanation paragraph shows file+line chips on hover; click to jump to that section in the editor
- **Diff view**: each section chip has a `⊞` zone — click it to open a VS Code diff editor scoped to just that section, showing exactly what changed
- **More detail**: expand any explanation paragraph to get a deeper dive on that specific part
- **Files changed panel**: resizable panel showing every changed file with progress status (explained, current, upcoming)
- **Ask Grug**: type any question about the current step and get a plain-English answer streamed directly into the panel
- **Explain dumber**: one click to get a simpler explanation
- **Rephrase**: get a completely different take on the same concept
- **Jump to any step**: dropdown nav or click directly from the summary screen
- **Session resume**: close VS Code and reopen — ELIG remembers your last session and drops you back where you left off
- **Restart session**: hit `↺` at any time to discard the current session and start fresh
- **Works with any AI**: uses the VS Code Language Model API — no separate API key needed

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
| `elig.githubToken` | _(empty)_ | GitHub PAT for private repo PR diffs (public repos work without one) |

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
