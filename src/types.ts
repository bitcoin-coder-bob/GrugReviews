export interface DiffHunk {
  newStart: number;
  newEnd: number;
  context: string;   // text after @@ e.g. " function handleAuth"
  lines: string[];   // up to 20 +/- lines for prompt context
}

export interface DiffFile {
  filename: string;
  patch: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface FileSection {
  filename: string;
  startLine: number;
  endLine: number;
  label: string;
  diffLines?: string[]; // raw +/- lines from the matching hunk
}

export interface ExplanationPart {
  text: string;
  refs: number[]; // 0-based indices into this step's sections array
}

export interface LessonStep {
  title: string;
  sections: FileSection[];
  explanation: string; // plain-text fallback (derived or streamed)
  explanationParts?: ExplanationPart[];
  confidence?: 'high' | 'medium' | 'low';
  uncertainty?: string; // one sentence, only present when confidence is medium/low
}

export interface LessonPlan {
  prTitle: string;
  summary: string;
  steps: LessonStep[];
}
