import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OkfDocument } from './okf-utils.js';

export type DealPilotGoalStatus = 'planned' | 'active' | 'blocked' | 'completed' | 'cancelled';

export interface DealPilotGoal {
  id: string;
  action_ref: string;
  title: string;
  deal_ref?: string;
  status: DealPilotGoalStatus;
  due_at?: string;
  priority?: string;
  reason?: string;
  updated_at: string;
}

export interface DealPilotWorkflow {
  id: string;
  name: string;
  status: 'idle' | 'ready' | 'active';
  goal_ids: string[];
  updated_at: string;
}

export interface DealPilotRuntime {
  goals: DealPilotGoal[];
  workflows: DealPilotWorkflow[];
}

const statusMap: Record<string, DealPilotGoalStatus> = {
  planned: 'planned',
  active: 'active',
  blocked: 'blocked',
  done: 'completed',
  completed: 'completed',
  cancelled: 'cancelled',
};

function runtimeDir(workspace: string): string {
  return path.join(workspace, 'storage', 'indexes');
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')) as T; } catch { return fallback; }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temp, filePath);
}

function workflowStatus(goals: DealPilotGoal[]): DealPilotWorkflow['status'] {
  if (goals.some(goal => goal.status === 'active')) return 'active';
  if (goals.some(goal => goal.status === 'planned')) return 'ready';
  return 'idle';
}

export async function reconcileGoalRuntime(
  workspace: string,
  actions: OkfDocument[],
  now = new Date(),
  persist = true,
): Promise<DealPilotRuntime> {
  const existing = await readJson<DealPilotRuntime>(
    path.join(runtimeDir(workspace), 'dealpilot-runtime.json'),
    { goals: [], workflows: [] },
  );
  const goals: DealPilotGoal[] = actions.map((action) => {
    const meta = action.meta;
    const id = `goal:${action.ref}`;
    const previous = existing.goals.find(item => item.id === id);
    return {
      id,
      action_ref: action.ref,
      title: String(meta.title || path.basename(action.ref, '.md')),
      deal_ref: meta.deal,
      status: statusMap[String(meta.status || 'active')] || 'active',
      due_at: meta.due_at,
      priority: meta.priority,
      reason: meta.reason,
      updated_at: String(meta.generated?.at || previous?.updated_at || now.toISOString()),
    };
  });
  const activeGoals = goals.filter(goal => goal.status === 'active' || goal.status === 'planned');
  const workflows: DealPilotWorkflow[] = [{
    id: 'today-follow-up',
    name: '销售跟进流程',
    status: workflowStatus(activeGoals),
    goal_ids: activeGoals.map(goal => goal.id),
    updated_at: now.toISOString(),
  }];
  const runtime = { goals, workflows };
  if (persist) await writeJson(path.join(runtimeDir(workspace), 'dealpilot-runtime.json'), runtime);
  return runtime;
}

export async function readGoalRuntime(workspace: string): Promise<DealPilotRuntime> {
  return readJson(path.join(runtimeDir(workspace), 'dealpilot-runtime.json'), { goals: [], workflows: [] });
}

export async function syncGoalRuntime(workspace: string, now = new Date()): Promise<DealPilotRuntime> {
  const { readConceptDir } = await import('./okf-utils.js');
  return reconcileGoalRuntime(workspace, await readConceptDir(workspace, 'knowledge/actions'), now);
}
