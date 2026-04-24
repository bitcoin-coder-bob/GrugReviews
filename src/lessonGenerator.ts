import * as vscode from 'vscode';
import { DiffFile, DiffHunk, FileSection, LessonPlan, LessonStep } from './types';
import { outputChannel } from './extension';

export async function selectModel(): Promise<vscode.LanguageModelChat> {
  const models = await vscode.lm.selectChatModels();
  if (models.length === 0) {
    throw new Error(
      'No language models available. Please install GitHub Copilot or another language model extension.',
    );
  }
  const preferred = models.find(m => /gpt-4|claude|gemini|o1/i.test(m.family));
  return preferred ?? models[0];
}

export function modelDisplayName(model: vscode.LanguageModelChat): string {
  return model.name || model.family || model.vendor;
}

function formatFileForPrompt(file: DiffFile): string {
  const header = `FILE: ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`;
  if (!file.hunks.length) return header + '\n  (no diff content)';

  const hunkLines = file.hunks.map(h => {
    const ctx = h.context ? ` ${h.context}` : '';
    const diffPreview = h.lines.slice(0, 12).join('\n    ');
    return `  @@ line ${h.newStart}–${h.newEnd}${ctx}\n    ${diffPreview}`;
  });

  return [header, ...hunkLines].join('\n');
}

const STEP_SCHEMA = `{
  "title": "string",
  "confidence": "high | medium | low — high if the diff clearly shows intent, low if key context is missing or the change is ambiguous",
  "uncertainty": "one sentence explaining what is unclear — only include when confidence is medium or low",
  "sections": [
    {
      "filename": "exact filename",
      "startLine": <number matching one of the hunk start lines above>,
      "label": "short phrase describing what this specific code section does"
    }
  ],
  "explanationParts": [
    {
      "text": "2-4 sentences explaining this part of the change — reference specific function/variable names",
      "refs": [0, 1]
    }
  ]
}`;

export async function generateLessonPlan(
  diffFiles: DiffFile[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  onProgress: (text: string) => void = () => {},
): Promise<LessonPlan> {
  const allFilenames = diffFiles.map(f => f.filename);

  onProgress(`Preparing ${diffFiles.length} file diff${diffFiles.length !== 1 ? 's' : ''}...`);
  const diffSummary = diffFiles.map(formatFileForPrompt).join('\n\n---\n\n');

  // Build a flat hunk reference so we can validate/resolve startLine -> endLine later
  // Map: "filename:startLine" -> hunk
  const hunkMap = new Map<string, DiffHunk>();
  for (const file of diffFiles) {
    for (const hunk of file.hunks) {
      hunkMap.set(`${file.filename}:${hunk.newStart}`, hunk);
    }
  }

  const prompt = `You are explaining a code change to a developer who wants plain, simple language. No jargon. Short sentences. Grug brain mode.

Here are ALL ${allFilenames.length} changed files with their exact diff hunks and line numbers:
${diffSummary}

Respond with ONLY a valid JSON object (no markdown fences) with this structure:
{
  "prTitle": "string",
  "summary": "string (4-6 sentence plain-English overview of the whole change — what problem it solves, what the main approach is, and what the biggest pieces are)",
  "steps": [ ${STEP_SCHEMA}, ... ]
}

Rules:
- Max 6 steps. Group logically related hunks into the same step.
- Order steps: foundational changes first (types/config), then core logic, then UI/tests last.
- CRITICAL: Every file's every hunk must appear in at least one section across all steps. Do not skip any hunk.
- sections[].startLine must exactly match one of the "line X" numbers shown above for that file.
- explanationParts is an array of paragraphs. Each paragraph has "text" (2-4 sentences) and "refs" (array of 0-based section indices it primarily discusses).
- A paragraph can reference multiple sections. A section can appear in multiple paragraphs. refs can be empty for general context.
- Name specific functions, types, or variables from the diff in each paragraph — not just the file in general.
- Each section needs its own label describing what that specific code block does.`;

  const messages = [vscode.LanguageModelChatMessage.User(prompt)];

  async function fetchRaw(attempt: number): Promise<string> {
    onProgress(attempt === 1
      ? `Asking ${modelDisplayName(model)} to analyze changes...`
      : `Retrying (model may still be initializing)...`);
    const response = await model.sendRequest(messages, {}, token);
    let result = '';
    let lastProgressBytes = 0;
    for await (const chunk of response.text) {
      result += chunk;
      if (result.length - lastProgressBytes >= 400) {
        lastProgressBytes = result.length;
        onProgress(`Receiving response... ${(result.length / 1000).toFixed(1)}kb`);
      }
    }
    return result;
  }

  let raw = await fetchRaw(1);
  if (!raw.trim()) {
    // Model returned nothing — common right after VS Code starts before the provider is ready
    await new Promise(r => setTimeout(r, 2000));
    raw = await fetchRaw(2);
  }
  if (!raw.trim()) {
    throw new Error('Model returned an empty response. This can happen when VS Code has just started and the AI provider is still initializing. Please wait a moment and try again.');
  }

  onProgress('Parsing lesson plan...');

  // Extract the outermost {...} — handles preamble text, code fences, trailing notes
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    raw = raw.slice(jsonStart, jsonEnd + 1);
  }

  let parsed: LessonPlan;
  try {
    parsed = JSON.parse(raw) as LessonPlan;
  } catch {
    outputChannel.appendLine('=== ELIG: Model returned invalid JSON ===');
    outputChannel.appendLine(raw);
    outputChannel.appendLine('=== END RAW RESPONSE ===');
    outputChannel.show(true);
    throw new Error(`Model returned invalid JSON. Raw response:\n${raw.slice(0, 800)}`);
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('Model returned an empty lesson plan.');
  }

  // Derive plain-text explanation from explanationParts for streaming fallback
  parsed.steps = parsed.steps.map(step => {
    const parts = (step as any).explanationParts as { text: string; refs: number[] }[] | undefined;
    const explanation = parts?.map(p => p.text).join('\n\n') ?? (step.explanation ?? '');
    return { ...step, explanation, explanationParts: parts };
  });

  // Resolve endLine for each section.
  // Trust the AI's startLine — only derive endLine from the hunk that contains it.
  parsed.steps = parsed.steps.map(step => ({
    ...step,
    sections: (step.sections ?? []).map(sec => {
      // If the AI emitted just a basename, resolve it to the full repo-relative path.
      let filename = sec.filename;
      if (!diffFiles.find(f => f.filename === filename)) {
        const base = filename.split('/').pop() ?? filename;
        const byBase = diffFiles.filter(f => (f.filename.split('/').pop() ?? f.filename) === base);
        if (byBase.length === 1) filename = byBase[0].filename;
      }

      const fileHunks = diffFiles.find(f => f.filename === filename)?.hunks ?? [];

      // Exact match on hunk start
      const exact = hunkMap.get(`${filename}:${sec.startLine}`);
      if (exact) {
        return { ...sec, filename, endLine: exact.newEnd, diffLines: exact.lines };
      }

      // AI gave a line inside a hunk — find the hunk that contains it
      const containing = fileHunks.find(h => sec.startLine >= h.newStart && sec.startLine <= h.newEnd);
      if (containing) {
        // Keep AI's startLine; cap end at hunk end, but at most +30 lines
        return { ...sec, filename, endLine: Math.min(sec.startLine + 30, containing.newEnd), diffLines: containing.lines };
      }

      // Fallback: AI gave a line outside any known hunk; use a fixed window
      return { ...sec, filename, endLine: sec.startLine + 25, diffLines: [] };
    }),
  }));

  // Ensure every file is represented — append missing files as sections on the last step
  const coveredFiles = new Set(parsed.steps.flatMap(s => s.sections.map(sec => sec.filename)));
  const missingFiles = allFilenames.filter(f => !coveredFiles.has(f));
  if (missingFiles.length > 0) {
    const lastStep = parsed.steps[parsed.steps.length - 1];
    for (const filename of missingFiles) {
      const file = diffFiles.find(f => f.filename === filename);
      const firstHunk = file?.hunks[0];
      lastStep.sections.push({
        filename,
        startLine: firstHunk?.newStart ?? 1,
        endLine: firstHunk?.newEnd ?? 1,
        label: `${filename} (additional changes)`,
      });
    }
  }

  onProgress(`Ready — ${parsed.steps.length} step${parsed.steps.length !== 1 ? 's' : ''} planned`);
  return parsed;
}

export async function askQuestion(
  step: LessonStep,
  question: string,
  model: vscode.LanguageModelChat,
  onChunk: (text: string) => void,
  token: vscode.CancellationToken,
): Promise<void> {
  const sectionList = step.sections
    .map(s => `  ${s.filename}:${s.startLine}–${s.endLine} — ${s.label}`)
    .join('\n');

  const prompt = `You are Grug, a simple caveman programmer. Answer this question about the code change step titled "${step.title}" in plain, simple language. Short sentences. No jargon. Mention specific functions or variables by name where relevant. Under 5 sentences. Just the answer — no intro.\n\nCode sections:\n${sectionList}\n\nCurrent explanation: ${step.explanation}\n\nQuestion: ${question}`;

  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const response = await model.sendRequest(messages, {}, token);

  for await (const chunk of response.text) {
    onChunk(chunk);
  }
}

export async function expandExplanation(
  step: LessonStep,
  partText: string,
  partRefs: number[],
  model: vscode.LanguageModelChat,
  onChunk: (text: string) => void,
  token: vscode.CancellationToken,
): Promise<void> {
  const referencedSections = partRefs
    .map(i => step.sections[i])
    .filter(Boolean)
    .map(s => `  ${s.filename}:${s.startLine}–${s.endLine} — ${s.label}`)
    .join('\n');

  const prompt = `You are Grug, a simple caveman programmer. A developer wants MORE DETAIL on one part of a code explanation.

Step: "${step.title}"
${referencedSections ? `Relevant code sections:\n${referencedSections}\n` : ''}
Existing explanation: "${partText}"

Go deeper on this specific part. Cover WHY this change was made, HOW it works in more detail, and any important implications or edge cases. Name specific functions and variables. Plain language, but more thorough than the original. 4-6 sentences. Just the explanation — no intro phrases.`;

  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const response = await model.sendRequest(messages, {}, token);
  for await (const chunk of response.text) {
    onChunk(chunk);
  }
}

export async function reexplain(
  step: LessonStep,
  mode: 'dumber' | 'rephrase' | 'review' | 'learn',
  model: vscode.LanguageModelChat,
  onChunk: (text: string) => void,
  token: vscode.CancellationToken,
): Promise<void> {
  const sectionList = step.sections
    .map(s => `  ${s.filename}:${s.startLine}–${s.endLine} — ${s.label}`)
    .join('\n');

  const prompts: Record<typeof mode, string> = {
    dumber: `Explain "${step.title}" even more simply. Imagine explaining to someone who just wrote their first line of code. No technical terms. Short sentences. 4-5 sentences max. Still mention the specific functions/variables by name. Just the explanation — no intro.\n\nCode sections:\n${sectionList}`,
    rephrase: `Rephrase the explanation of "${step.title}" in a completely different way. Still simple, plain, 4-5 sentences. Still mention the specific functions/variables by name. Just the new explanation — no intro.\n\nCode sections:\n${sectionList}\n\nOriginal: ${step.explanation}`,
    review: `You are reviewing this code change for a colleague. For step "${step.title}", explain what specifically was changed and why — the intent, the problem it solves, and any trade-offs or risks worth noting. Name specific functions and variables. Direct and concise. Under 5 sentences. Just the explanation — no intro.\n\nCode sections:\n${sectionList}\n\nOriginal: ${step.explanation}`,
    learn: `Explain step "${step.title}" for a developer trying to understand the codebase. Focus on what the code conceptually DOES — build intuition about its purpose and behavior, not just what lines changed. Name specific functions and variables. Simple language. Under 5 sentences. Just the explanation — no intro.\n\nCode sections:\n${sectionList}\n\nOriginal: ${step.explanation}`,
  };

  const messages = [vscode.LanguageModelChatMessage.User(prompts[mode])];
  const response = await model.sendRequest(messages, {}, token);

  for await (const chunk of response.text) {
    onChunk(chunk);
  }
}

// Derive unique filenames from a step's sections
export function stepFilenames(step: LessonStep): string[] {
  return [...new Set(step.sections.map(s => s.filename))];
}

// Build a coverage map: filename -> all step indices that cover it
export function buildFileCoverage(steps: LessonStep[]): Record<string, number[]> {
  const map: Record<string, number[]> = {};
  for (const [i, step] of steps.entries()) {
    for (const sec of step.sections) {
      if (!(sec.filename in map)) map[sec.filename] = [];
      if (!map[sec.filename].includes(i)) map[sec.filename].push(i);
    }
  }
  return map;
}
