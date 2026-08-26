// DealPilot DSH — Action Transition Tool
// State machine for action lifecycle: complete, cancel, block, reopen, schedule.
// TypeScript implementation.
import * as path from 'node:path';
import { readYamlFrontmatter, writeYamlFrontmatter, appendBusinessEvent, updateStorageIndex, readConceptDir, resolveWorkspace, normalizeRef, } from './okf-utils.js';
import { syncGoalRuntime } from './goal-runtime.js';
import { createConfirmation, consumeConfirmation } from './confirmation.js';
import { actionPresentation } from './business-view.js';
// ── Valid Transitions ───────────────────────────────────────────────────────
const VALID_TRANSITIONS = {
    active: ['complete', 'cancel', 'block', 'schedule'],
    planned: ['active', 'cancel', 'schedule'],
    blocked: ['reopen', 'cancel'],
    done: ['reopen'],
    cancelled: ['reopen'],
};
const STATUS_MAP = {
    active: 'active',
    complete: 'done',
    cancel: 'cancelled',
    block: 'blocked',
    reopen: 'active',
    schedule: 'planned',
};
// ── Tool Registration ───────────────────────────────────────────────────────
export function registerActionTool(ctx, harness) {
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_action_transition',
        description: `转换 Action 的状态。

支持的状态转换：
- active → complete: 完成行动（状态变为 done）
- active → cancel: 取消行动（状态变为 cancelled）
- active → block: 阻塞行动（状态变为 blocked）
- active → schedule: 安排后续跟进（状态变为 planned）
- planned → active: 开始行动
- planned → cancel: 取消计划
- blocked → reopen: 重新打开（状态变为 active）
- blocked → cancel: 取消阻塞的行动
- done → reopen: 重新打开已完成的行动
- cancelled → reopen: 重新打开已取消的行动

规则：
- 每个 Deal 最多一个 active Action
- 转换合法性自动校验
- 每次转换自动追加 business-events.jsonl`,
        parameters: {
            type: 'object',
            properties: {
                action_ref: {
                    type: 'string',
                    description: 'Action 的引用路径（如 knowledge/actions/xxx.md）',
                },
                transition: {
                    type: 'string',
                    enum: ['active', 'complete', 'cancel', 'block', 'reopen', 'schedule'],
                    description: '要执行的状态转换',
                },
                reason: {
                    type: 'string',
                    description: '转换原因（可选，会写入 action 的 reason 字段）',
                },
                due_at: {
                    type: 'string',
                    description: '新的到期日（可选，ISO 8601 日期格式）',
                },
                evidence: {
                    type: 'string',
                    description: '完成证据（complete 时可选）',
                },
                confirmation_token: {
                    type: 'string',
                    description: '用户确认预览后返回的一次性确认令牌',
                },
            },
            required: ['action_ref', 'transition'],
        },
        output: {
            schema: { type: 'object' },
            render(_args, value) {
                const result = JSON.parse(value);
                if (result.requires_confirmation) {
                    return [{ type: 'text', text: `${result.message}\nconfirmation_token: ${result.confirmation_token}\npreview: ${JSON.stringify(result.preview || {})}` }];
                }
                return [{ type: 'text', text: `跟进任务状态已更新\nDATA_JSON: ${JSON.stringify(result)}` }];
            },
            presentationMeta(args, value) {
                return actionPresentation(args, value);
            },
        },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            const { action_ref, transition, reason, due_at, evidence, confirmation_token } = args;
            const safeActionRef = normalizeRef(workspace, 'knowledge/actions/index.md', action_ref);
            const confirmationPayload = { action_ref: safeActionRef, transition, reason: reason || null, due_at: due_at || null, evidence: evidence || null };
            if (!confirmation_token) {
                return JSON.stringify(createConfirmation('dealpilot_action_transition', confirmationPayload, '这是一个会改变跟进任务状态的操作。请向用户展示当前状态、目标状态和原因，获得明确确认后再重试。'));
            }
            consumeConfirmation(confirmation_token, 'dealpilot_action_transition', confirmationPayload);
            const now = new Date().toISOString();
            const result = await transitionAction(workspace, safeActionRef, transition, { reason, due_at, evidence }, now);
            await syncGoalRuntime(workspace, new Date(now));
            return JSON.stringify(result);
        },
    }));
}
// ── Core Logic ──────────────────────────────────────────────────────────────
export async function transitionAction(workspace, ref, transition, options, now) {
    const safeRef = normalizeRef(workspace, 'knowledge/actions/index.md', ref);
    const filePath = path.join(workspace, safeRef);
    // Read current state
    let meta;
    let body;
    try {
        const doc = await readYamlFrontmatter(filePath);
        meta = doc.meta;
        body = doc.body;
    }
    catch (err) {
        throw new Error(`无法读取行动：${safeRef}`);
    }
    const currentStatus = meta.status || 'unknown';
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed) {
        throw new Error(`未知状态 "${currentStatus}"。已知状态: ${Object.keys(VALID_TRANSITIONS).join(', ')}`);
    }
    if (!allowed.includes(transition)) {
        throw new Error(`非法转换: ${currentStatus} → ${transition}。` +
            `允许的转换: ${allowed.join(', ')}`);
    }
    // Validate active action limit for transitions that result in active
    const newStatus = STATUS_MAP[transition];
    if (newStatus === 'active') {
        await validateActiveActionLimit(workspace, meta.deal, safeRef);
    }
    // Update meta
    const updated = { ...meta };
    updated.status = newStatus;
    if (options.reason)
        updated.reason = options.reason;
    if (options.due_at)
        updated.due_at = options.due_at;
    if (options.evidence)
        updated.completion_evidence = options.evidence;
    updated.generated = { ...(meta.generated || {}), at: now };
    // Write back
    await writeYamlFrontmatter(filePath, updated, body);
    // Append event
    const eventType = transition === 'complete' ? 'action.completed' :
        transition === 'cancel' ? 'action.cancelled' :
            transition === 'block' ? 'action.blocked' :
                transition === 'reopen' ? 'action.reopened' :
                    transition === 'schedule' ? 'action.scheduled' :
                        `action.${transition}`;
    await appendBusinessEvent(workspace, {
        occurred_at: now,
        event_type: eventType,
        action_ref: safeRef,
        deal_ref: meta.deal,
        channel: 'chat',
        generated_by: 'dealpilot-dsh',
        summary: options.reason || `${currentStatus} → ${newStatus}`,
    });
    // Update index
    await updateStorageIndex(workspace, 'action', {
        ref: safeRef,
        ...updated,
        deal_ref: meta.deal,
        updated_at: now,
    });
    return {
        ok: true,
        ref: safeRef,
        previousStatus: currentStatus,
        newStatus: updated.status,
        transition,
    };
}
// ── Active Action Limit ─────────────────────────────────────────────────────
async function validateActiveActionLimit(workspace, dealRef, excludeRef) {
    if (!dealRef)
        return; // No deal to check against
    const actions = await readConceptDir(workspace, 'knowledge/actions');
    for (const doc of actions) {
        if (doc.meta.deal !== dealRef)
            continue;
        if (excludeRef && doc.ref === excludeRef)
            continue;
        if (doc.meta.status === 'active') {
            throw new Error(`每个 Deal 最多一个 active Action。` +
                `Deal ${dealRef} 已有 active Action: ${doc.ref}`);
        }
    }
}
