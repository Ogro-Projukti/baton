import { z } from 'zod';

export const TaskStateSchema = z.enum([
  'opened', 'triaged', 'awaiting_plan', 'plan_saved', 'race_ready', 'running', 'done', 'abandoned',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;
export const TerminalStates = new Set<TaskState>(['done', 'abandoned']);

export const TriageSchema = z.object({
  needs_planning: z.boolean(),
  reason: z.string().min(1),
  complexity: z.enum(['low', 'med', 'high']),
  platform: z.enum(['chatgpt', 'gemini', 'claude']),
  attach_files: z.array(z.string()).max(20),
}).strict();
export type Triage = z.infer<typeof TriageSchema>;

export const PlanStepSchema = z.object({
  id: z.string().regex(/^S\d+$/),
  title: z.string().min(1),
  type: z.enum(['code', 'refactor', 'test', 'docs', 'research', 'review']),
  complexity: z.enum(['low', 'med', 'high']),
  depends_on: z.array(z.string()),
  parallel_group: z.string().min(1),
  files: z.array(z.string()),
  plan_ref: z.string().min(1),
  acceptance: z.string().min(1),
}).strict();
export type PlanStep = z.infer<typeof PlanStepSchema>;
export const PlanSummarySchema = z.object({
  task: z.string().min(1), goal: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1), risks: z.array(z.string()),
}).strict();
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

export const StateFileSchema = z.object({
  status: TaskStateSchema,
  history: z.array(z.object({ status: TaskStateSchema, at: z.string(), reason: z.string() })),
  parent_task_id: z.string().optional(),
  plan_file: z.string().optional(),
});
export type StateFile = z.infer<typeof StateFileSchema>;

export const RaceMapSchema = z.object({
  task_id: z.string(), plan_file: z.string().optional(),
  steps: z.array(PlanStepSchema.extend({ agent: z.string(), model: z.string().nullable(), handoff: z.string() })),
  groups: z.array(z.array(z.string())),
});
export type RaceMap = z.infer<typeof RaceMapSchema>;

export function nextAction(state: TaskState): string {
  return ({ opened: 'triage task', triaged: 'prepare plan or race', awaiting_plan: 'awaiting plan',
    plan_saved: 'build race', race_ready: 'ready to run', running: 'review results',
    done: 'create follow-up task', abandoned: 'create follow-up task' } as const)[state];
}
