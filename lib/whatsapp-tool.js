// DealPilot DSH — WhatsApp Tool
// WhatsApp Web integration: pull messages, analyze, prepare drafts.
// TypeScript implementation.
import { readConceptDir, resolveWorkspace } from './okf-utils.js';
// ── Registration ────────────────────────────────────────────────────────────
export function registerWhatsappTool(ctx, harness) {
    harness.registerTool(ctx, harness.defineTool({
        name: 'dealpilot_whatsapp',
        description: `与 WhatsApp Web 集成，拉取消息、分析对话、生成回复草稿。

支持三种操作：
- pull_messages: 拉取指定对话的最新消息
- analyze: 分析消息内容，关联客户和交易，更新状态
- prepare_draft: 基于分析结果生成回复草稿

注意：此工具依赖 Chrome 扩展从 WhatsApp Web DOM 提取消息。
如果没有扩展，Agent 可以直接将消息内容作为 messages 参数传入。`,
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['pull_messages', 'analyze', 'prepare_draft'],
                    description: '操作类型',
                },
                conversation_key: {
                    type: 'string',
                    description: 'WhatsApp 对话标识符（如 "John Doe"）',
                },
                messages: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            sender: { type: 'string', description: '发送者（"me" 或联系人名）' },
                            text: { type: 'string', description: '消息内容' },
                            timestamp: { type: 'string', description: '消息时间' },
                        },
                    },
                    description: '消息列表（pull_messages 时为空，analyze 和 prepare_draft 时传入）',
                },
                customer_ref: {
                    type: 'string',
                    description: '关联的客户 ref（可选，用于 analyze 时关联）',
                },
                deal_ref: {
                    type: 'string',
                    description: '关联的交易 ref（可选）',
                },
            },
            required: ['action'],
        },
        async execute(args) {
            const workspace = resolveWorkspace(ctx.config);
            if (!workspace) {
                throw new Error('No workspace configured.');
            }
            const { action, conversation_key, messages, customer_ref, deal_ref } = args;
            if (action === 'pull_messages') {
                return JSON.stringify({
                    ok: true,
                    action: 'pull_messages',
                    conversation_key,
                    hint: '请使用 Chrome 扩展从 WhatsApp Web 拉取消息，或手动粘贴消息内容。',
                });
            }
            if (action === 'analyze') {
                if (!messages || messages.length === 0) {
                    throw new Error('analyze 需要 messages 参数');
                }
                return JSON.stringify(await analyzeMessages(workspace, conversation_key, messages, customer_ref, deal_ref));
            }
            if (action === 'prepare_draft') {
                if (!messages || messages.length === 0) {
                    throw new Error('prepare_draft 需要 messages 参数');
                }
                return JSON.stringify(prepareDraft(conversation_key, messages, customer_ref, deal_ref));
            }
            throw new Error(`Unknown action: ${action}`);
        },
    }));
}
// ── Analyze Messages ────────────────────────────────────────────────────────
async function analyzeMessages(workspace, conversationKey, messages, customerRef, _dealRef) {
    // Find matching customer
    let customer = null;
    if (customerRef) {
        const docs = await readConceptDir(workspace, 'knowledge/customers');
        const found = docs.find(d => d.ref === customerRef);
        if (found) {
            customer = { ref: found.ref, title: found.meta.title };
        }
    }
    if (!customer && conversationKey) {
        // Try fuzzy match by conversation key
        const docs = await readConceptDir(workspace, 'knowledge/customers');
        const keyLower = conversationKey.toLowerCase();
        const found = docs.find(d => (d.meta.title || '').toLowerCase().includes(keyLower));
        if (found) {
            customer = { ref: found.ref, title: found.meta.title };
        }
    }
    // Extract key facts from messages
    const facts = extractFacts(messages);
    const sentiment = analyzeSentiment(messages);
    const lastMessage = messages[messages.length - 1];
    return {
        ok: true,
        action: 'analyze',
        conversation_key: conversationKey,
        customer: customer ? { ref: customer.ref, title: customer.title } : null,
        message_count: messages.length,
        last_message_at: lastMessage?.timestamp || null,
        last_message_from: lastMessage?.sender || null,
        last_message_text: lastMessage?.text || null,
        facts,
        sentiment,
        suggested_actions: generateSuggestedActions(facts, sentiment),
    };
}
// ── Prepare Draft ───────────────────────────────────────────────────────────
function prepareDraft(conversationKey, messages, _customerRef, _dealRef) {
    const facts = extractFacts(messages);
    const sentiment = analyzeSentiment(messages);
    // Generate a draft reply based on context
    const language = detectLanguage(messages);
    const draft = language === 'zh'
        ? generateChineseDraft(facts, sentiment)
        : generateEnglishDraft(facts, sentiment);
    return {
        ok: true,
        action: 'prepare_draft',
        conversation_key: conversationKey,
        draft,
        draft_length: draft.length,
        language,
        note: '草稿仅供参考，请审核后发送。',
    };
}
// ── Analysis Helpers ────────────────────────────────────────────────────────
function extractFacts(messages) {
    const facts = [];
    const keywords = {
        price: /\b(price|pricing|quote|quotation|cost|USD|EUR|RMB|元|报价|价格|费用)\b/i,
        quantity: /\b(quantity|amount|volume|MOQ|pieces|units|数量|起订量)\b/i,
        deadline: /\b(deadline|due|by\s+\w+\s+\d+|before\s+\w+|期限|截止|之前)\b/i,
        requirement: /\b(require|need|spec|specification|certification|要求|需要|规格|认证)\b/i,
        competitor: /\b(competitor|other supplier|another|竞争|其他供应商|别家)\b/i,
    };
    for (const msg of messages) {
        if (msg.sender === 'me')
            continue;
        for (const [type, regex] of Object.entries(keywords)) {
            if (regex.test(msg.text)) {
                facts.push({ type, text: msg.text.slice(0, 200), from: msg.sender, at: msg.timestamp });
                break;
            }
        }
    }
    return facts.slice(0, 10);
}
function analyzeSentiment(messages) {
    const positiveWords = /\b(thanks|great|good|interested|please|yes|ok|好的|谢谢|感兴趣|可以|没问题|很好)\b/i;
    const negativeWords = /\b(no|not interested|too expensive|expensive|later|不用|太贵|不感兴趣|再说|算了)\b/i;
    let positive = 0;
    let negative = 0;
    for (const msg of messages) {
        if (msg.sender === 'me')
            continue;
        if (positiveWords.test(msg.text))
            positive++;
        if (negativeWords.test(msg.text))
            negative++;
    }
    if (positive > negative)
        return 'positive';
    if (negative > positive)
        return 'negative';
    return 'neutral';
}
function detectLanguage(messages) {
    let zhCount = 0;
    let enCount = 0;
    for (const msg of messages) {
        for (const ch of msg.text || '') {
            if (/[\u4e00-\u9fff]/.test(ch))
                zhCount++;
            if (/[a-zA-Z]/.test(ch))
                enCount++;
        }
    }
    return zhCount > enCount ? 'zh' : 'en';
}
function generateChineseDraft(facts, sentiment) {
    const hasPrice = facts.some(f => f.type === 'price');
    const hasRequirement = facts.some(f => f.type === 'requirement');
    if (hasPrice && hasRequirement) {
        return '感谢您的询价和需求说明。我会尽快确认相关信息并给您回复。如有其他问题，请随时告知。';
    }
    if (hasPrice) {
        return '感谢您的询价。我会尽快准备报价单并发送给您。';
    }
    if (sentiment === 'positive') {
        return '好的，感谢您的回复。我会跟进处理并及时更新进展。';
    }
    return '感谢您的消息。我会尽快回复您。';
}
function generateEnglishDraft(facts, sentiment) {
    const hasPrice = facts.some(f => f.type === 'price');
    const hasRequirement = facts.some(f => f.type === 'requirement');
    if (hasPrice && hasRequirement) {
        return 'Thank you for your inquiry and requirements. I will review and get back to you shortly. Please let me know if you have any other questions.';
    }
    if (hasPrice) {
        return 'Thank you for your inquiry. I will prepare a quotation and send it to you soon.';
    }
    if (sentiment === 'positive') {
        return 'Great, thank you for your reply. I will follow up and keep you updated on the progress.';
    }
    return 'Thank you for your message. I will get back to you shortly.';
}
function generateSuggestedActions(facts, sentiment) {
    const actions = [];
    if (facts.some(f => f.type === 'price')) {
        actions.push({ action: 'prepare_quote', description: 'Prepare quotation for customer' });
    }
    if (facts.some(f => f.type === 'requirement')) {
        actions.push({ action: 'clarify_requirements', description: 'Verify and document customer requirements' });
    }
    if (facts.some(f => f.type === 'deadline')) {
        actions.push({ action: 'set_reminder', description: 'Set deadline reminder' });
    }
    if (sentiment === 'positive') {
        actions.push({ action: 'advance_stage', description: 'Consider advancing funnel stage' });
    }
    return actions;
}
