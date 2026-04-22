import * as vscode from 'vscode';
import { DiffFile, FileSection, LessonPlan, LessonStep } from './types';

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
  "sections": [
    {
      "filename": "exact filename",
      "startLine": <number matching one of the hunk start lines above>,
      "label": "short phrase describing what this specific code section does (e.g. 'validateToken — checks expiry and signature')"
    }
  ],
  "explanation": "string — 4-6 sentences that specifically reference what changed in each section by name, not just the file"
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
  const hunkMap = new Map<string, { newStart: number; newEnd: number }>();
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
- The explanation must specifically name functions, types, or variables from the diff — not just describe the file in general.
- Each section needs its own label describing what that specific code block does.`;

  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  onProgress(`Asking ${modelDisplayName(model)} to analyze changes...`);
  const response = await model.sendRequest(messages, {}, token);

  let raw = '';
  let lastProgressBytes = 0;
  for await (const chunk of response.text) {
    raw += chunk;
    // Post a size update roughly every 400 chars so the user sees it's alive
    if (raw.length - lastProgressBytes >= 400) {
      lastProgressBytes = raw.length;
      onProgress(`Receiving response... ${(raw.length / 1000).toFixed(1)}kb`);
    }
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
    throw new Error(`Model returned invalid JSON. Raw response:\n${raw.slice(0, 400)}`);
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('Model returned an empty lesson plan.');
  }

  // Resolve endLine for each section.
  // Trust the AI's startLine — only derive endLine from the hunk that contains it.
  parsed.steps = parsed.steps.map(step => ({
    ...step,
    sections: (step.sections ?? []).map(sec => {
      const fileHunks = diffFiles.find(f => f.filename === sec.filename)?.hunks ?? [];

      // Exact match on hunk start
      const exact = hunkMap.get(`${sec.filename}:${sec.startLine}`);
      if (exact) {
        return { ...sec, endLine: exact.newEnd };
      }

      // AI gave a line inside a hunk — find the hunk that contains it
      const containing = fileHunks.find(h => sec.startLine >= h.newStart && sec.startLine <= h.newEnd);
      if (containing) {
        // Keep AI's startLine; cap end at hunk end, but at most +30 lines
        return { ...sec, endLine: Math.min(sec.startLine + 30, containing.newEnd) };
      }

      // Fallback: AI gave a line outside any known hunk; use a fixed window
      return { ...sec, endLine: sec.startLine + 25 };
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

export async function reexplain(
  step: LessonStep,
  mode: 'dumber' | 'rephrase',
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

// Build a coverage map: filename -> index of first step that covers it
export function buildFileCoverage(steps: LessonStep[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [i, step] of steps.entries()) {
    for (const sec of step.sections) {
      if (!(sec.filename in map)) map[sec.filename] = i;
    }
  }
  return map;
}
