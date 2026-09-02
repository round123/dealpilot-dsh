import * as fs from 'node:fs/promises';
import * as path from 'node:path';
const statusMap = {
    planned: 'planned',
    active: 'active',
    blocked: 'blocked',
    done: 'completed',
    completed: 'completed',
    cancelled: 'cancelled',
};
function runtimeDir(workspace) {
    return path.join(workspace, 'storage', 'indexes');
}
async function readJson(filePath, fallback) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    }
    catch {
        return fallback;
    }
}
async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await fs.rename(temp, filePath);
}
function workflowStatus(goals) {
    if (goals.some(goal => goal.status === 'active'))
        return 'active';
    if (goals.some(goal => goal.status === 'planned'))
        return 'ready';
    return 'idle';
}
export async function reconcileGoalRuntime(workspace, actions, now = new Date(), persist = true) {
    const existing = await readJson(path.join(runtimeDir(workspace), 'dealpilot-runtime.json'), { goals: [], workflows: [] });
    const goals = actions.map((action) => {
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
    const workflows = [{
            id: 'today-follow-up',
            name: '销售跟进流程',
            status: workflowStatus(activeGoals),
            goal_ids: activeGoals.map(goal => goal.id),
            updated_at: now.toISOString(),
        }];
    const runtime = { goals, workflows };
    if (persist)
        await writeJson(path.join(runtimeDir(workspace), 'dealpilot-runtime.json'), runtime);
    return runtime;
}
export async function readGoalRuntime(workspace) {
    return readJson(path.join(runtimeDir(workspace), 'dealpilot-runtime.json'), { goals: [], workflows: [] });
}
export async function syncGoalRuntime(workspace, now = new Date()) {
    const { readConceptDir } = await import('./okf-utils.js');
    return reconcileGoalRuntime(workspace, await readConceptDir(workspace, 'knowledge/actions'), now);
}
