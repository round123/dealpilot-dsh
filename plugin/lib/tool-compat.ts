import { defineTool } from '@deepseek-ai/dsh-tools';

type LegacyTool = {
  name: string;
  description: string;
  parameters?: {
    type?: string;
    properties?: Record<string, Record<string, any>>;
    required?: string[];
  };
  output?: {
    schema?: Record<string, any>;
    render?: (agent: any, value: string) => any[];
  };
  execute: (args: any) => Promise<any>;
};

function normalizeSchema(schema: Record<string, any>): Record<string, any> {
  const normalized = { ...schema };
  if (normalized.type === 'object') {
    if (normalized.properties) {
      if (normalized.additionalProperties === undefined) normalized.additionalProperties = false;
      normalized.properties = Object.fromEntries(
        Object.entries(normalized.properties).map(([key, value]) => [key, normalizeSchema(value as Record<string, any>)]),
      );
    } else if (normalized.additionalProperties === undefined) {
      normalized.additionalProperties = true;
    }
  }
  if (normalized.items && typeof normalized.items === 'object') {
    normalized.items = normalizeSchema(normalized.items);
  }
  return normalized;
}

/** Adapt the pre-0.1.1 tool shape to the DSH tool registry contract. */
export function createToolHarness(ctx: Record<string, any>, _toolCtx?: Record<string, any>) {
  return {
    defineTool(tool: LegacyTool) {
      const legacyParameters = tool.parameters ?? {};
      const required = new Set(legacyParameters.required ?? []);
      const parameters = Object.fromEntries(
        Object.entries(legacyParameters.properties ?? {}).map(([name, schema]) => [
          name,
          { ...normalizeSchema(schema), ...(required.has(name) ? { required: true } : {}) },
        ]),
      );
      const legacyOutput = tool.output;

      return (defineTool as any)({
        name: tool.name,
        description: tool.description,
        parameters: parameters as any,
        output: {
          schema: normalizeSchema(legacyOutput?.schema ?? { type: 'json' }) as any,
          render(args: any, value: any) {
            if (legacyOutput?.render) return legacyOutput.render(args, JSON.stringify(value));
            return [{ type: 'text', text: JSON.stringify(value) }];
          },
        },
        async execute(args: any, _exec: any) {
          const result = await tool.execute(args);
          if (typeof result !== 'string') return result;
          try {
            return JSON.parse(result);
          } catch {
            return result;
          }
        },
      });
    },
    registerTool(_ctx: Record<string, any>, tool: any) {
      if (!ctx.tools?.register) throw new Error('DSH tools service is unavailable');
      ctx.tools.register(tool);
    },
  };
}
