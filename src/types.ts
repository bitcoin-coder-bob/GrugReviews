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
}

export interface LessonStep {
  title: string;
  sections: FileSection[];
  explanation: string;
}

export interface LessonPlan {
  prTitle: string;
  summary: string;
  steps: LessonStep[];
}
