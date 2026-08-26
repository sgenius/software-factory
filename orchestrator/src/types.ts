// Mirrors schemas/*.schema.json. Keep in sync by hand — schemaValidation.ts
// validates real payloads against the JSON Schema files at runtime, these
// types are the compile-time view of the same contracts.

export interface Plan {
  taskId: string;
  requirement: string;
  tasks: Array<{
    id: string;
    description: string;
    dependsOn?: string[];
  }>;
  filesToTouch: Array<{
    path: string;
    reason: string;
  }>;
  acceptanceCriteria: Array<{
    id: string;
    description: string;
  }>;
  notes?: string;
}

export type FindingSeverity = "blocking" | "nit" | "question";

export interface ReviewFinding {
  taskId: string;
  file: string;
  line: number;
  endLine?: number;
  severity: FindingSeverity;
  summary: string;
  rationale?: string;
  rubricRef?: string;
}

export type Stage =
  | "planning"
  | "coding"
  | "testing"
  | "review"
  | "human_gate"
  | "done"
  | "failed";

export type TaskStatus = "in_progress" | "done" | "failed";

export interface Spend {
  tokens: number;
  costUsd: number;
}

export interface Budget {
  maxTokens: number;
  maxCostUsd: number;
}

export interface HistoryEntry {
  stepId: string;
  stage: Stage;
  event: string;
  timestamp: string;
}

export interface TaskState {
  taskId: string;
  stage: Stage;
  status: TaskStatus;
  fixReviewCycles: number;
  maxFixReviewCycles: number;
  escalated: boolean;
  spend: Spend;
  budget: Budget;
  failureReason?: string;
  history: HistoryEntry[];
}

export interface PlannerQuestionOption {
  label: string;
  description?: string;
}

export interface PlannerQuestion {
  id: string;
  header: string;
  question: string;
  options: PlannerQuestionOption[];
}

export interface PlannerAnswer {
  questionId: string;
  selectedLabel: string;
  notes?: string;
}

export type PlannerTurn =
  | { taskId: string; type: "questions"; questions: PlannerQuestion[] }
  | { taskId: string; type: "plan"; plan: Plan };

export interface TestCriterionResult {
  criterionId: string;
  passed: boolean;
  reason?: string;
}

export interface TestResult {
  taskId: string;
  results: TestCriterionResult[];
  testsRun: string[];
}

export interface ReviewResult {
  taskId: string;
  findings: ReviewFinding[];
  confidence: number;
}
