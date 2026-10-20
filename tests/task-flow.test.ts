import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parsePlanSummary, PlanFormatError } from '../src/plan-summary';
import { deterministicScope } from '../src/scope-rules';
import { TaskFiles } from '../src/task-files';
import { buildRace, overlapWarnings, saveRace } from '../src/race-map';
import { TaskFlow } from '../src/task-flow';
import { TaskOutputManager, SessionViewOutputRouter } from '../src/task-output';
import { hashPlan, extractOrGetPlanSummary } from '../src/plan-extractor';
import { validatePlanSummaryStructure } from '../src/plan-summary';
import { getStepSummary, listSummaries, getPlanSummary } from '../src/mcp/data';
import { TARGETS } from '../src/handoff';
import { classifyPromptIntent, routeToUserAgent } from '../src/router/agent-router';
import { clearPersonalKey, DEFAULT_KEYS, preferredKey, savePersonalKey } from '../src/secrets';
import type { UserAgentConfig } from '../src/types';
import { SessionRecordSchema, TaskRecordSchema, type SessionRecord, type TaskRecord } from '../src/types';
import './panel-leak.test';

const valid = `# Work\n## Step 1\nFix it.\n## Step 2\nReview it.\n<!-- BATON:SUMMARY:START -->\ntask: fix-login\ngoal: Fix login\nsteps:\n  - id: S1\n    title: Fix login\n    type: code\n    complexity: med\n    depends_on: []\n    parallel_group: A\n    files: [src/login.ts]\n    plan_ref: "## Step 1"\n    acceptance: Login succeeds\n  - id: S2\n    title: Review\n    type: review\n    complexity: low\n    depends_on: [S1]\n    parallel_group: B\n    files: [src/login.ts]\n    plan_ref: "## Step 2"\n    acceptance: Review passes\nrisks:\n  - Existing sessions\n<!-- BATON:SUMMARY:END -->`;

test('summary parses and validates each required failure', () => {
  assert.equal(parsePlanSummary(valid).steps.length, 2);
  const invalid: Array<[string, string]> = [
    [valid.replace('<!-- BATON:SUMMARY:END -->', ''), 'markers'],
    [valid.replace('goal: Fix login', 'goal Fix login'), 'YAML'],
    [valid.replace('  - id: S2', '  - id: S1'), 'Duplicate step ID'],
    [valid.replace('depends_on: [S1]', 'depends_on: [S9]'), 'missing step'],
    [valid.replace('depends_on: []', 'depends_on: [S2]'), 'Dependency cycle'],
    [valid.replace('type: review', 'type: deploy'), 'type'],
    [valid.replace('complexity: low', 'complexity: extreme'), 'complexity'],
    [valid.replace('"## Step 2"', '"## Missing"'), 'plan_ref heading'],
  ];
  for (const [plan, error] of invalid) {
    assert.throws(() => parsePlanSummary(plan), (thrown) => thrown instanceof PlanFormatError && thrown.message.includes(error));
  }
});

test('scope lock allows clarifications and rejects explicit drift', () => {
  assert.equal(deterministicScope('Fix login in src/login.ts', 'Actually, cover password reset in src/login.ts too'), 'same');
  assert.equal(deterministicScope('Fix login in src/login.ts', 'Separately, add a dashboard chart'), 'drift');
  assert.equal(deterministicScope('Fix login in src/login.ts', 'Add chart for sales by region and month'), 'drift');
});

test('two tasks keep separate state and resume after restart', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-flow-'));
  try {
    const repo = path.join(temp, 'repo');
    const files = new TaskFiles(path.join(temp, 'storage'));
    const first = await files.createTask(repo, 'Fix login');
    const second = await files.createTask(repo, 'Fix checkout');
    await files.transition(first.task, 'triaged', 'Needs plan');
    await files.transition(first.task, 'awaiting_plan', 'Waiting');
    await writeFile(path.join(first.task, 'planning_prompt.md'), 'Prompt one', 'utf8');
    await files.transition(second.task, 'triaged', 'Simple task');
    const secondSummary = { ...parsePlanSummary(valid), task: second.slug,
      steps: [{ ...parsePlanSummary(valid).steps[0], files: ['src/checkout.ts'] }] };
    const secondRace = buildRace(secondSummary, second.id);
    await saveRace(files, second, secondRace);
    const reopened = new TaskFiles(path.join(temp, 'storage'));
    assert.equal((await reopened.state(first.task)).status, 'awaiting_plan');
    assert.equal(await readFile(path.join(first.task, 'planning_prompt.md'), 'utf8'), 'Prompt one');
    assert.equal((await reopened.state(second.task)).status, 'race_ready');
    assert.equal((await reopened.readRace(first.task)), undefined);
    assert.equal((await reopened.readRace(second.task))?.steps[0].files[0], 'src/checkout.ts');
    assert.equal((await reopened.listTasks(repo)).length, 2);
    await reopened.transition(first.task, 'plan_saved', 'Plan received');
    const firstRace = buildRace(parsePlanSummary(valid), first.id, 'plans/plan_fix-login_abcd.md');
    await saveRace(reopened, first, firstRace);
    assert.deepEqual(await overlapWarnings(reopened, repo, second, secondRace), []);
    const competing = buildRace({ ...secondSummary,
      steps: [{ ...secondSummary.steps[0], files: ['src/login.ts'] }] }, second.id);
    await saveRace(reopened, second, competing);
    assert.match((await overlapWarnings(reopened, repo, second, competing))[0], /src\/login\.ts/);
    const edited = buildRace({ ...parsePlanSummary(valid), steps: parsePlanSummary(valid).steps.map((step) =>
      step.id === 'S2' ? { ...step, acceptance: 'New review check' } : step) }, first.id, firstRace.plan_file);
    assert.deepEqual(await saveRace(reopened, first, edited), ['handoffs/H2.md']);
    await reopened.transition(first.task, 'done', 'Complete');
    await assert.rejects(reopened.transition(first.task, 'running', 'Again'), /read-only/);
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('full flow takes the direct and planning branches', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-flow-'));
  try {
    const repo = path.join(temp, 'repo');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'login.ts'), 'export const login = true;\n', 'utf8');
    const storage = path.join(temp, 'storage');
    const flow = new TaskFlow(storage);
    const direct = await flow.start(repo, 'Fix login in src/login.ts');
    assert.equal(direct.needsPlanning, false);
    assert.equal((await flow.files.state(direct.location.task)).status, 'race_ready');
    assert.equal((await flow.files.readRace(direct.location.task))?.steps.length, 1);
    const beforeDrift = await readFile(path.join(direct.location.task, 'task.md'), 'utf8');
    assert.equal((await flow.acceptInput(repo, direct.location.id, 'Separately, add a sales dashboard')).accepted, false);
    assert.equal(await readFile(path.join(direct.location.task, 'task.md'), 'utf8'), beforeDrift);
    assert.equal((await flow.acceptInput(repo, direct.location.id, 'Actually, fix the login response in src/login.ts')).accepted, true);

    const planned = await flow.start(repo, 'Refactor architecture across services');
    assert.equal(planned.needsPlanning, true);
    assert.match(planned.prompt ?? '', /## Task/);
    const reopened = new TaskFlow(storage);
    assert.equal((await reopened.inspectSession(repo, planned.location.id))?.state, 'awaiting_plan');
    assert.equal((await reopened.inspectSession(repo, planned.location.id))?.prompt, planned.prompt);
    const fullPlan = valid.replace('task: fix-login', `task: ${planned.location.slug}`);
    const result = await reopened.submitPlan(repo, planned.location.id, fullPlan);
    assert.equal(result.changed.length, 2);
    assert.equal((await reopened.files.state(planned.location.task)).status, 'race_ready');
    assert.match(result.notice, /Files not attached/);
    const storedPlan = (await reopened.files.state(planned.location.task)).plan_file;
    assert.ok(storedPlan?.startsWith(path.join('plans', `plan_${planned.location.slug}_`)));
    assert.equal(await readFile(path.join(planned.location.task, storedPlan!), 'utf8'), fullPlan);
    assert.equal((await reopened.files.readRace(direct.location.task))?.steps.length, 1);
    await reopened.files.transition(direct.location.task, 'done', 'Complete');
    assert.match((await reopened.acceptInput(repo, direct.location.id, 'Fix login again')).reason, /closed/);
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('cross-session isolation: concurrent tasks never leak output across views and buffers persist', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-output-'));
  try {
    const repo = path.join(temp, 'repo');
    const files = new TaskFiles(path.join(temp, 'storage'));
    const first = await files.createTask(repo, 'Task A');
    const second = await files.createTask(repo, 'Task B');

    const outputManager = new TaskOutputManager(files);
    const viewRouter = new SessionViewOutputRouter(outputManager);

    // Mount view for Task A
    viewRouter.setActiveTask(first.id);
    assert.equal(viewRouter.getActiveTaskId(), first.id);

    // Task A streams first chunk
    await outputManager.appendChunk('proj-alpha', first.id, 'run-A1', 'A chunk 1', 'stdout', first.task);
    assert.deepEqual(viewRouter.getRenderedOutput().map((c) => c.chunk), ['A chunk 1']);

    // User switches view to Task B mid-stream
    viewRouter.setActiveTask(second.id);
    assert.equal(viewRouter.getActiveTaskId(), second.id);
    assert.deepEqual(viewRouter.getRenderedOutput(), []);

    // Concurrently stream output for both tasks
    await Promise.all([
      (async () => {
        await outputManager.appendChunk('proj-alpha', first.id, 'run-A1', 'A chunk 2', 'stdout', first.task);
        await outputManager.appendChunk('proj-alpha', first.id, 'run-A1', 'A chunk 3', 'stdout', first.task);
        await outputManager.appendChunk('proj-alpha', first.id, 'run-A1', 'A chunk 4', 'stdout', first.task);
      })(),
      (async () => {
        await outputManager.appendChunk('proj-alpha', second.id, 'run-B1', 'B chunk 1', 'stdout', second.task);
        await outputManager.appendChunk('proj-alpha', second.id, 'run-B1', 'B chunk 2', 'stderr', second.task);
      })(),
    ]);

    // Assert Task B view NEVER contains any Task A output
    const bRendered = viewRouter.getRenderedOutput();
    assert.deepEqual(bRendered.map((c) => c.chunk), ['B chunk 1', 'B chunk 2']);
    assert.ok(bRendered.every((c) => c.task_id === second.id));
    assert.ok(!bRendered.some((c) => c.task_id === first.id));

    // Switch view back to Task A
    viewRouter.setActiveTask(first.id);
    const aRendered = viewRouter.getRenderedOutput();

    // Assert Task A's rendered buffer is completely intact with all chunks in order
    assert.deepEqual(aRendered.map((c) => c.chunk), ['A chunk 1', 'A chunk 2', 'A chunk 3', 'A chunk 4']);
    assert.ok(aRendered.every((c) => c.task_id === first.id));

    // Verify persistence to log.jsonl
    const logContent = await readFile(path.join(first.task, 'log.jsonl'), 'utf8');
    const lines = logContent.trim().split('\n').map((line) => JSON.parse(line));
    const outputLines = lines.filter((line) => line.event === 'output');
    assert.equal(outputLines.length, 4);
    for (const line of outputLines) {
      assert.equal(line.project_id, 'proj-alpha');
      assert.equal(line.task_id, first.id);
      assert.equal(line.run_id, 'run-A1');
    }

    // Verify reloading from log restores task A's output buffer completely
    const restoredManager = new TaskOutputManager(files);
    const restoredA = await restoredManager.loadFromLog(first.task, 'proj-alpha', first.id);
    assert.deepEqual(restoredA.map((c) => c.chunk), ['A chunk 1', 'A chunk 2', 'A chunk 3', 'A chunk 4']);

    // Verify unsubscription / cleanup
    viewRouter.dispose();
    await outputManager.appendChunk('proj-alpha', first.id, 'run-A1', 'A chunk 5', 'stdout', first.task);
    assert.deepEqual(viewRouter.getRenderedOutput(), []);
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('plan extraction caches by SHA-256 hash and deterministically validates structure', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-plan-test-'));
  try {
    const plan = `# Implementation Plan\n\n## Step 1: Core Refactor\nRefactor core modules.\n\n## Step 2: Add Tests\nAdd unit tests.\n<!-- BATON:SUMMARY:START -->\ntask: core-refactor\ngoal: Refactor core modules and add tests\nsteps:\n  - id: S1\n    title: Core Refactor\n    type: code\n    complexity: med\n    depends_on: []\n    parallel_group: A\n    files: [src/core.ts]\n    plan_ref: "## Step 1: Core Refactor"\n    acceptance: Core logic refactored\n  - id: S2\n    title: Add Tests\n    type: test\n    complexity: low\n    depends_on: [S1]\n    parallel_group: B\n    files: [tests/core.test.ts]\n    plan_ref: "## Step 2: Add Tests"\n    acceptance: All tests pass\nrisks:\n  - Regression\n<!-- BATON:SUMMARY:END -->`;

    const res1 = await extractOrGetPlanSummary(plan, 'core-refactor', temp);
    assert.equal(res1.cached, false);
    assert.equal(res1.summary.steps.length, 2);

    const res2 = await extractOrGetPlanSummary(plan, 'core-refactor', temp);
    assert.equal(res2.cached, true);
    assert.deepEqual(res1.summary, res2.summary);

    // Deterministic validation checks
    const badRef = JSON.parse(JSON.stringify(res1.summary));
    badRef.steps[0].plan_ref = '## Nonexistent Heading';
    assert.throws(() => validatePlanSummaryStructure(badRef, plan), /plan_ref heading does not exist/);

    const dupId = JSON.parse(JSON.stringify(res1.summary));
    dupId.steps[1].id = 'S1';
    assert.throws(() => validatePlanSummaryStructure(dupId, plan), /Duplicate step ID/);

    const cycle = JSON.parse(JSON.stringify(res1.summary));
    cycle.steps[0].depends_on = ['S2'];
    assert.throws(() => validatePlanSummaryStructure(cycle, plan), /Dependency cycle/);
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('task flow step summaries, MCP tools, and step readiness progression', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-mcp-test-'));
  const repo = path.join(temp, 'repo');
  const storage = path.join(temp, 'storage');
  await mkdir(repo, { recursive: true });
  await mkdir(storage, { recursive: true });

  const flow = new TaskFlow(storage);
  process.env.BATON_PROJECT_ROOT = repo;
  process.env.BATON_MEMORY_PATH = path.join(storage, 'memory.json');

  try {
    const started = await flow.start(repo, 'Refactor payment service');
    const taskId = started.location.id;

    const planText = `# Payments\n## Step 1: Migration\nMigrate schema.\n## Step 2: Verification\nVerify payments.\n<!-- BATON:SUMMARY:START -->\ntask: ${started.location.slug}\ngoal: Payment migration\nsteps:\n  - id: S1\n    title: Migration\n    type: code\n    complexity: med\n    depends_on: []\n    parallel_group: A\n    files: [src/pay.ts]\n    plan_ref: "## Step 1: Migration"\n    acceptance: Migrated\n  - id: S2\n    title: Verification\n    type: test\n    complexity: low\n    depends_on: [S1]\n    parallel_group: B\n    files: [tests/pay.test.ts]\n    plan_ref: "## Step 2: Verification"\n    acceptance: Verified\nrisks:\n  - None\n<!-- BATON:SUMMARY:END -->`;

    await flow.submitPlan(repo, taskId, planText, ['src/pay.ts']);

    // Inspect initial session: only S1 is ready because S2 depends on S1
    let session = await flow.inspectSession(repo, taskId);
    assert.deepEqual(session?.readySteps, ['S1']);

    // Save summary for S1
    const res1 = await flow.saveStepSummary(repo, taskId, 'S1', 'Completed database migration without issues.');
    assert.equal(res1.allDone, false);
    assert.deepEqual(res1.readySteps, ['S1', 'S2']); // S2 is now ready!

    // Verify MCP tools can read S1's summary
    const s1Summary = (await getStepSummary(taskId, 'S1')) as { summary: string };
    assert.equal(s1Summary.summary, 'Completed database migration without issues.');

    const allSummaries = (await listSummaries(taskId)) as { taskId: string; summaries: Array<{ step_id: string; summary: string }> };
    assert.equal(allSummaries.summaries.length, 1);
    assert.equal(allSummaries.summaries[0].step_id, 'S1');

    const planSummary = (await getPlanSummary(taskId)) as { task: string; steps: unknown[] };
    assert.equal(planSummary?.task, started.location.slug);
    assert.equal(planSummary?.steps?.length, 2);

    // Save summary for S2 -> marks allDone!
    const res2 = await flow.saveStepSummary(repo, taskId, 'S2', 'All payment tests passed.');
    assert.equal(res2.allDone, true);

    // Verify session shows both step summaries saved
    session = await flow.inspectSession(repo, taskId);
    assert.equal(session?.stepSummaries?.['S1'], 'Completed database migration without issues.');
    assert.equal(session?.stepSummaries?.['S2'], 'All payment tests passed.');
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('completion lock (backend rejects input after done)', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-lock-test-'));
  try {
    const repo = path.join(temp, 'repo');
    await mkdir(repo, { recursive: true });
    const storage = path.join(temp, 'storage');
    const flow = new TaskFlow(storage);

    const started = await flow.start(repo, 'Fix typo in src/index.ts');
    const taskId = started.location.id;

    // Transition task to done
    await flow.files.transition(started.location.task, 'done', 'Work completed');
    const doneState = await flow.files.state(started.location.task);
    assert.equal(doneState.status, 'done');

    // Backend must reject input once done
    const rejectedDone = await flow.acceptInput(repo, taskId, 'Try modifying finished work');
    assert.equal(rejectedDone.accepted, false);
    assert.match(rejectedDone.reason, /closed/i);

    // Also verify abandoned task is locked
    const abandoned = await flow.start(repo, 'Direct task in src/abandon.ts');
    await flow.files.transition(abandoned.location.task, 'abandoned', 'Abandoned by user');
    const rejectedAbandoned = await flow.acceptInput(repo, abandoned.location.id, 'Try to edit abandoned task');
    assert.equal(rejectedAbandoned.accepted, false);
    assert.match(rejectedAbandoned.reason, /closed/i);
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('step readiness unlock after a summary is saved', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-step-readiness-'));
  try {
    const repo = path.join(temp, 'repo');
    await mkdir(repo, { recursive: true });
    const storage = path.join(temp, 'storage');
    const flow = new TaskFlow(storage);

    const started = await flow.start(repo, 'Build multi-stage auth');
    const taskId = started.location.id;

    const planText = `# Multi-Stage Auth
## Step 1: Database Migration
Migrate user tables.
## Step 2: Auth Endpoints
Implement JWT logic.
## Step 3: End-to-End Tests
Verify authentication.
<!-- BATON:SUMMARY:START -->
task: ${started.location.slug}
goal: Multi-stage auth implementation
steps:
  - id: S1
    title: Database Migration
    type: code
    complexity: low
    depends_on: []
    parallel_group: A
    files: [src/db.ts]
    plan_ref: "## Step 1: Database Migration"
    acceptance: Schema migrated
  - id: S2
    title: Auth Endpoints
    type: code
    complexity: med
    depends_on: [S1]
    parallel_group: B
    files: [src/auth.ts]
    plan_ref: "## Step 2: Auth Endpoints"
    acceptance: JWT routes functional
  - id: S3
    title: End-to-End Tests
    type: test
    complexity: low
    depends_on: [S2]
    parallel_group: C
    files: [tests/auth.test.ts]
    plan_ref: "## Step 3: End-to-End Tests"
    acceptance: All tests green
risks:
  - None
<!-- BATON:SUMMARY:END -->`;

    await flow.submitPlan(repo, taskId, planText, ['src/db.ts', 'src/auth.ts', 'tests/auth.test.ts']);

    // Initially: S1 ready, S2 & S3 blocked
    let session = await flow.inspectSession(repo, taskId);
    assert.deepEqual(session?.readySteps, ['S1']);

    // Step 1 done -> Step 2 unlocks, Step 3 remains blocked
    const res1 = await flow.saveStepSummary(repo, taskId, 'S1', 'User table migration applied.');
    assert.equal(res1.allDone, false);
    assert.deepEqual(res1.readySteps, ['S1', 'S2']);
    assert.ok(!res1.readySteps.includes('S3'));

    // Step 2 done -> Step 3 unlocks
    const res2 = await flow.saveStepSummary(repo, taskId, 'S2', 'Endpoints implemented.');
    assert.equal(res2.allDone, false);
    assert.deepEqual(res2.readySteps, ['S1', 'S2', 'S3']);

    // Step 3 done -> allDone true
    const res3 = await flow.saveStepSummary(repo, taskId, 'S3', 'All tests passing.');
    assert.equal(res3.allDone, true);
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('plan extraction retry-with-error', async () => {
  const planMarkdown = `# Feature Refactor\n\n## Step 1: Core Logic\nImplement core logic.\n\n## Step 2: Verification\nRun verification.`;
  const calls: string[] = [];

  const customExtractor = async (systemPrompt: string) => {
    calls.push(systemPrompt);
    if (calls.length === 1) {
      // First attempt returns invalid plan_ref heading that doesn't exist in markdown
      return {
        task: 'feat-refactor',
        goal: 'Refactor core logic and verify',
        steps: [
          {
            id: 'S1',
            title: 'Core Logic',
            type: 'code' as const,
            complexity: 'med' as const,
            depends_on: [],
            parallel_group: 'A',
            files: ['src/core.ts'],
            plan_ref: '## Nonexistent Heading',
            acceptance: 'Done',
          },
        ],
        risks: [],
      };
    }
    // Second attempt fixes the heading reference
    return {
      task: 'feat-refactor',
      goal: 'Refactor core logic and verify',
      steps: [
        {
          id: 'S1',
          title: 'Core Logic',
          type: 'code' as const,
          complexity: 'med' as const,
          depends_on: [],
          parallel_group: 'A',
          files: ['src/core.ts'],
          plan_ref: '## Step 1: Core Logic',
          acceptance: 'Done',
        },
      ],
      risks: [],
    };
  };

  const { summary } = await extractOrGetPlanSummary(planMarkdown, 'feat-refactor', undefined, customExtractor);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('Previous extraction error:'));
  assert.ok(calls[1].includes('S1 plan_ref heading does not exist: ## Nonexistent Heading.'));
  assert.equal(summary.steps[0].plan_ref, '## Step 1: Core Logic');
});

test('extraction failure message', async () => {
  const planMarkdown = `# Malformed Plan\nSome unstructured text without valid headings.`;
  const failingExtractor = async () => {
    throw new Error('LLM JSON parse error: unexpected token');
  };

  await assert.rejects(
    () => extractOrGetPlanSummary(planMarkdown, 'malformed-task', undefined, failingExtractor),
    (err: Error) => {
      assert.ok(err.message.includes('Unable to extract a valid plan structure:'));
      assert.ok(err.message.includes('LLM JSON parse error'));
      return true;
    },
  );
});

test('no-planning single-step path', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-direct-'));
  try {
    const repo = path.join(temp, 'repo');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'calc.ts'), 'export const add = (a: number, b: number) => a + b;\n', 'utf8');
    const storage = path.join(temp, 'storage');
    const flow = new TaskFlow(storage);

    // Single direct task without needing external architectural planning
    const started = await flow.start(repo, 'Fix addition in src/calc.ts');
    assert.equal(started.needsPlanning, false);
    assert.equal((await flow.files.state(started.location.task)).status, 'race_ready');

    const race = await flow.files.readRace(started.location.task);
    assert.ok(race);
    assert.equal(race.steps.length, 1);
    assert.equal(race.steps[0].depends_on.length, 0);
    assert.ok(race.steps[0].agent);
    assert.ok(race.steps[0].handoff);
    const handoffContent = await readFile(path.join(started.location.task, race.steps[0].handoff), 'utf8');
    assert.ok(handoffContent.includes('S1:'));
    assert.ok(handoffContent.includes('Agent:'));
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('resume from awaiting_plan', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-resume-'));
  try {
    const repo = path.join(temp, 'repo');
    await mkdir(repo, { recursive: true });
    const storage = path.join(temp, 'storage');

    // Instance 1: Starts a complex task that transitions to awaiting_plan
    const flow1 = new TaskFlow(storage);
    const started = await flow1.start(repo, 'Redesign microservice architecture across domains');
    assert.equal(started.needsPlanning, true);
    assert.ok(started.prompt);
    assert.equal((await flow1.files.state(started.location.task)).status, 'awaiting_plan');

    // Instance 2: Simulates editor / extension restart, reads state from disk
    const flow2 = new TaskFlow(storage);
    const session = await flow2.inspectSession(repo, started.location.id);
    assert.ok(session);
    assert.equal(session.state, 'awaiting_plan');
    assert.equal(session.prompt, started.prompt);

    // Submit plan on restarted instance
    const planText = `# Architecture\n## Step 1: Design\nDesign services.\n<!-- BATON:SUMMARY:START -->\ntask: ${started.location.slug}\ngoal: Architecture redesign\nsteps:\n  - id: S1\n    title: Design\n    type: code\n    complexity: med\n    depends_on: []\n    parallel_group: A\n    files: [src/arch.ts]\n    plan_ref: "## Step 1: Design"\n    acceptance: Architecture designed\nrisks:\n  - None\n<!-- BATON:SUMMARY:END -->`;

    const submitResult = await flow2.submitPlan(repo, started.location.id, planText, ['src/arch.ts']);
    assert.ok(submitResult.changed.length > 0);

    const updatedState = await flow2.files.state(started.location.task);
    assert.equal(updatedState.status, 'race_ready');
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('external planning service URLs map correctly', () => {
  assert.equal(TARGETS.claude, 'https://claude.ai/new');
  assert.equal(TARGETS.gemini, 'https://gemini.google.com/app');
  assert.equal(TARGETS.chatgpt, 'https://chatgpt.com/');
});

test('agent router classifies intent and routes strictly within configured user agents', () => {
  // 1. Intent classification: planning & uncertainty -> web
  const planIntent = classifyPromptIntent('Design architecture and plan migration roadmap for auth service');
  assert.equal(planIntent.taskType, 'planning');
  assert.equal(planIntent.agentKind, 'web');

  // Research & discovery -> web
  const researchIntent = classifyPromptIntent('Research best practices and explore documentation for WebSocket scaling');
  assert.equal(researchIntent.taskType, 'research');
  assert.equal(researchIntent.agentKind, 'web');

  // Concrete testing / debugging / implementation -> local
  const testIntent = classifyPromptIntent('Fix null pointer exception in src/auth.ts and run npm test');
  assert.equal(testIntent.taskType, 'testing');
  assert.equal(testIntent.agentKind, 'local');

  const codeIntent = classifyPromptIntent('Create file src/utils/math.ts and implement add function');
  assert.equal(codeIntent.agentKind, 'local');

  // 2. Strict User Roster Routing: Only consider configured agents
  const roster: UserAgentConfig[] = [
    {
      id: 'agent-web-planner',
      name: 'Claude Architect',
      type: 'web',
      models: 'claude-3-7-sonnet',
      color: 'purple',
      githubAttached: true,
      url: 'https://github.com/my-org/my-repo',
      capabilities: ['planning', 'architecture'],
      enabled: true,
    },
    {
      id: 'agent-local-coder',
      name: 'Codex Runner',
      type: 'local',
      models: 'codex, gpt-4o',
      color: 'cyan',
      githubAttached: false,
      capabilities: ['code', 'cli'],
      enabled: true,
    },
  ];

  // Routing planning prompt -> selects web agent with GitHub attached
  const route1 = routeToUserAgent('Plan the database schema migration', roster);
  assert.equal(route1.selectedAgent.id, 'agent-web-planner');
  assert.equal(route1.agentKind, 'web');
  assert.equal(route1.githubAttached, true);
  assert.equal(route1.githubUrl, 'https://github.com/my-org/my-repo');

  // Routing code execution prompt -> selects local agent without GitHub
  const route2 = routeToUserAgent('Fix bug in auth.ts and run tests', roster);
  assert.equal(route2.selectedAgent.id, 'agent-local-coder');
  assert.equal(route2.agentKind, 'local');
  assert.equal(route2.githubAttached, false);

  // Conversational planning / how-to-build / development from scratch -> web
  const buildAppIntent = classifyPromptIntent('I want to develop a sql light viewe how to build a sqlight viewer, make me one');
  assert.equal(buildAppIntent.taskType, 'planning');
  assert.equal(buildAppIntent.agentKind, 'web');

  const howToIntent = classifyPromptIntent('how to build a realtime collaborative editor from scratch');
  assert.equal(howToIntent.taskType, 'planning');
  assert.equal(howToIntent.agentKind, 'web');

  // Direct mention override: user asks for a specific agent
  const route3 = routeToUserAgent('Let Codex Runner handle this architecture plan', roster);
  assert.equal(route3.selectedAgent.id, 'agent-local-coder');

  // Conversational planning routes to web agent
  const routeHowTo = routeToUserAgent('I want to develop a sql light viewe how to build a sqlight viewer, make me one', roster);
  assert.equal(routeHowTo.selectedAgent.id, 'agent-web-planner');
  assert.equal(routeHowTo.agentKind, 'web');

  // Routing with intelligent LLM route provided (Gemma tier)
  const routeFromLlm = routeToUserAgent('arbitrary prompt', roster, undefined, {
    task_type: 'planning',
    risk_tier: 'low',
    recommended_destination: 'chatgpt_web',
    research_needed: false,
    reason: 'Gemma 4 classified as architecture planning',
  });
  assert.equal(routeFromLlm.selectedAgent.id, 'agent-web-planner');
  assert.equal(routeFromLlm.agentKind, 'web');
  assert.equal(routeFromLlm.reason, 'Gemma 4 classified as architecture planning');

  // Fallback when only local agent configured in roster: stays within roster
  const localOnly: UserAgentConfig[] = [roster[1]];
  const route4 = routeToUserAgent('Plan strategic vision for product', localOnly);
  assert.equal(route4.selectedAgent.id, 'agent-local-coder');
  assert.ok(route4.reason.includes('Fallback'));

  // Throws if no agents configured
  assert.throws(() => routeToUserAgent('Do something', []), /No agents configured/);
});

test('multi-task race session: multiple prompts create sequential laps and finish race ends relay', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'baton-race-session-'));
  try {
    const repo = path.join(temp, 'repo');
    const storage = path.join(temp, 'storage');
    await mkdir(repo, { recursive: true });
    await mkdir(storage, { recursive: true });

    const flow = new TaskFlow(storage);

    // 1. Create a fresh race session
    let session: SessionRecord = SessionRecordSchema.parse({
      id: 'race-sess-1',
      title: 'New race session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceUri: repo,
      taskIds: [],
      turns: [],
    });
    assert.equal(session.title, 'New race session');
    assert.equal(session.finished, undefined);
    assert.deepEqual(session.taskIds, []);

    // 2. Lap 1: User routes first prompt in this race
    const lap1 = await flow.start(repo, 'Plan user login module');
    const task1: TaskRecord = TaskRecordSchema.parse({
      id: lap1.location.id,
      createdAt: new Date().toISOString(),
      text: 'Plan user login module',
      route: {
        task_type: 'planning',
        risk_tier: 'low',
        recommended_destination: 'chatgpt_web',
        research_needed: false,
        reason: 'Architectural planning',
      },
      routerTier: 'rules',
      decision: 'RUN',
      status: 'done',
      finishSummary: 'Architecture plan outlined in MCP',
      lapNumber: 1,
    });
    session = SessionRecordSchema.parse({
      ...session,
      title: 'Plan user login module',
      taskIds: [...(session.taskIds ?? []), lap1.location.id],
      turns: [
        ...(session.turns ?? []),
        { id: 'turn-1', role: 'user', content: 'Plan user login module', createdAt: new Date().toISOString(), taskId: lap1.location.id },
        { id: 'turn-2', role: 'assistant', content: 'Routed to Web Planner', createdAt: new Date().toISOString(), taskId: lap1.location.id },
      ],
    });

    assert.equal(session.taskIds?.length, 1);
    assert.equal(session.taskIds?.[0], lap1.location.id);

    // 3. Lap 2: User provides a second prompt in the SAME session without scope drift rejection
    const lap2 = await flow.start(repo, 'Implement OAuth handlers and write unit tests', lap1.location.id);
    const task2: TaskRecord = TaskRecordSchema.parse({
      id: lap2.location.id,
      createdAt: new Date().toISOString(),
      text: 'Implement OAuth handlers and write unit tests',
      route: {
        task_type: 'implementation',
        risk_tier: 'low',
        recommended_destination: 'codex',
        research_needed: false,
        reason: 'Direct code execution',
      },
      routerTier: 'rules',
      decision: 'RUN',
      status: 'routed',
      lapNumber: 2,
    });
    session = SessionRecordSchema.parse({
      ...session,
      taskIds: [...(session.taskIds ?? []), lap2.location.id],
      turns: [
        ...(session.turns ?? []),
        { id: 'turn-3', role: 'user', content: 'Implement OAuth handlers and write unit tests', createdAt: new Date().toISOString(), taskId: lap2.location.id },
        { id: 'turn-4', role: 'assistant', content: 'Routed to Local Codex', createdAt: new Date().toISOString(), taskId: lap2.location.id },
      ],
    });

    assert.equal(session.taskIds?.length, 2);
    assert.equal(session.taskIds?.[1], lap2.location.id);
    assert.equal(session.turns?.length, 4);

    // 4. Finish the race session
    const finishedTask1: TaskRecord = { ...task1, status: 'done', flowStatus: 'done' };
    const finishedTask2: TaskRecord = { ...task2, status: 'done', flowStatus: 'done' };
    const finishedSession: SessionRecord = SessionRecordSchema.parse({
      ...session,
      finished: true,
      turns: session.turns?.map((t) => ({ ...t, status: 'done' })),
    });

    assert.equal(finishedSession.finished, true);
    assert.equal(finishedTask1.status, 'done');
    assert.equal(finishedTask2.status, 'done');
    assert.equal(finishedTask1.lapNumber, 1);
    assert.equal(finishedTask2.lapNumber, 2);
  } finally {
    if (path.dirname(temp) === os.tmpdir()) await rm(temp, { recursive: true, force: true });
  }
});

test('straight-line relay track: calculates proper segment distances, agent colors, and final runner crossing', () => {
  const tasks = [
    { id: 't1', text: 'Task 1', lapNumber: 1, runnerAgent: { name: 'Codex CLI', color: 'cyan' } },
    { id: 't2', text: 'Task 2', lapNumber: 2, runnerAgent: { name: 'Claude Architect', color: 'purple' } },
  ];
  const N = tasks.length;
  const segments = tasks.map((t, i) => ({
    startPct: (i / N) * 100,
    endPct: ((i + 1) / N) * 100,
    agentColor: t.runnerAgent.color,
    isFinalCrossing: i === N - 1,
  }));

  assert.equal(segments[0].startPct, 0);
  assert.equal(segments[0].endPct, 50);
  assert.equal(segments[0].agentColor, 'cyan');
  assert.equal(segments[0].isFinalCrossing, false);

  assert.equal(segments[1].startPct, 50);
  assert.equal(segments[1].endPct, 100);
  assert.equal(segments[1].agentColor, 'purple');
  assert.equal(segments[1].isFinalCrossing, true);
});

test('preferredKey returns default shipped keys, allows personal override, and reverts when cleared', async () => {
  class MockSecretStorage {
    private map = new Map<string, string>();
    async get(key: string) { return this.map.get(key); }
    async store(key: string, value: string) { this.map.set(key, value); }
    async delete(key: string) { this.map.delete(key); }
  }

  const secrets = new MockSecretStorage() as any;
  DEFAULT_KEYS.gemma = 'default-gemma-key';
  DEFAULT_KEYS.ollama = 'default-ollama-key';
  DEFAULT_KEYS.elevenlabs = 'default-eleven-key';

  // 1. Without personal keys, returns default shipped keys
  assert.equal(await preferredKey(secrets, 'gemma'), 'default-gemma-key');
  assert.equal(await preferredKey(secrets, 'ollama'), 'default-ollama-key');
  assert.equal(await preferredKey(secrets, 'elevenlabs'), 'default-eleven-key');

  // 2. User sets personal key in Settings -> overrides default
  await savePersonalKey(secrets, 'gemma', 'user-personal-key');
  assert.equal(await preferredKey(secrets, 'gemma'), 'user-personal-key');
  assert.equal(await preferredKey(secrets, 'ollama'), 'default-ollama-key');

  // 3. User clears personal key -> reverts back to default
  await clearPersonalKey(secrets, 'gemma');
  assert.equal(await preferredKey(secrets, 'gemma'), 'default-gemma-key');
});

test('TaskRecordSchema and SessionRecordSchema accept long reasons without throwing', () => {
  const longReason = 'The user wants to transition from a CLI to a modern UI. This requires architectural planning and UI/UX research before any implementation begins. (Fallback: No web agent in roster, using Codex CLI). Detailed multi-paragraph architectural rationale with extended context.';
  assert.ok(longReason.length > 200);

  const route = {
    task_type: 'planning' as const,
    risk_tier: 'low' as const,
    recommended_destination: 'chatgpt_web' as const,
    research_needed: false,
    reason: longReason,
  };
  const task = {
    id: 't-long-reason',
    createdAt: new Date().toISOString(),
    text: 'Do some long task',
    route,
    routerTier: 'gemma' as const,
    decision: 'RUN',
    status: 'routed' as const,
  };
  assert.doesNotThrow(() => TaskRecordSchema.parse(task));

  const session = {
    id: 's-long-reason',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'Test Session',
    taskIds: ['t-long-reason'],
    turns: [
      {
        id: 'turn-1',
        role: 'user' as const,
        content: 'hello',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'turn-2',
        role: 'assistant' as const,
        content: longReason,
        createdAt: new Date().toISOString(),
        route,
      },
    ],
  };
  assert.doesNotThrow(() => SessionRecordSchema.parse(session));
});




