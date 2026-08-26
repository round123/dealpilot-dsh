import { defineTool } from '@deepseek-ai/dsh-tools';
import { getDealPilotSession } from './dealpilot-session.js';
import { runWithWorkspace } from './workspace-context.js';
function normalizeSchema(schema) {
    const normalized = { ...schema };
    if (normalized.type === 'object') {
        if (normalized.properties) {
            if (normalized.additionalProperties === undefined)
                normalized.additionalProperties = false;
            normalized.properties = Object.fromEntries(Object.entries(normalized.properties).map(([key, value]) => [key, normalizeSchema(value)]));
        }
        else if (normalized.additionalProperties === undefined) {
            normalized.additionalProperties = true;
        }
    }
    if (normalized.items && typeof normalized.items === 'object') {
        normalized.items = normalizeSchema(normalized.items);
    }
    return normalized;
}
/** Adapt the pre-0.1.1 tool shape to the DSH tool registry contract. */
export function createToolHarness(ctx, _toolCtx) {
    return {
        defineTool(tool) {
            const legacyParameters = tool.parameters ?? {};
            const required = new Set(legacyParameters.required ?? []);
            const parameters = Object.fromEntries(Object.entries(legacyParameters.properties ?? {}).map(([name, schema]) => [
                name,
                { ...normalizeSchema(schema), ...(required.has(name) ? { required: true } : {}) },
            ]));
            const legacyOutput = tool.output;
            return defineTool({
                name: tool.name,
                description: tool.description,
                parameters: parameters,
                output: {
                    schema: normalizeSchema(legacyOutput?.schema ?? { type: 'json' }),
                    render(args, value) {
                        if (legacyOutput?.render)
                            return legacyOutput.render(args, JSON.stringify(value));
                        return [{ type: 'text', text: JSON.stringify(value) }];
                    },
                    ...(legacyOutput?.presentationMeta ? {
                        presentationMeta(args, value) {
                            return legacyOutput.presentationMeta(args, value);
                        },
                    } : {}),
                },
                ...(tool.presentCall ? { presentCall: tool.presentCall } : {}),
                ...(tool.presentResult ? { presentResult: tool.presentResult } : {}),
                async execute(args, exec) {
                    const sessionId = exec?.agent?.id;
                    const context = getDealPilotSession(sessionId);
                    if (!context)
                        throw new Error('请先选择 DealPilot Workspace');
                    const result = await runWithWorkspace(context.sessionId, context.workspacePath, () => tool.execute(args));
                    if (typeof result !== 'string')
                        return result;
                    try {
                        return JSON.parse(result);
                    }
                    catch {
                        return result;
                    }
                },
            });
        },
        registerTool(_ctx, tool) {
            if (!ctx.tools?.register)
                throw new Error('DSH tools service is unavailable');
            ctx.tools.register(tool);
        },
    };
}
