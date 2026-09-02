import * as path from 'node:path';
const DEAL_STAGES = ['new', 'qualified', 'contacted', 'replied', 'opportunity', 'quoted', 'sample', 'negotiation', 'won', 'lost', 'unknown'];
const ACTION_STATUSES = ['planned', 'active', 'blocked', 'completed', 'cancelled'];
function isoDate(value) {
    return value.toISOString().slice(0, 10);
}
function startOfWeek(now) {
    const date = new Date(now);
    const day = date.getUTCDay();
    const offset = day === 0 ? 6 : day - 1;
    date.setUTCDate(date.getUTCDate() - offset);
    date.setUTCHours(0, 0, 0, 0);
    return date;
}
function eventInRange(event, start, end) {
    const occurred = String(event?.occurred_at || '').slice(0, 10);
    return occurred >= start && occurred <= end;
}
function daysSince(value, now) {
    if (!value)
        return Number.POSITIVE_INFINITY;
    const time = Date.parse(value);
    if (!Number.isFinite(time))
        return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.floor((now.getTime() - time) / 86400000));
}
export function buildOperationalViews(snapshot, now = new Date()) {
    const weekStart = startOfWeek(now);
    const periodStart = isoDate(weekStart);
    const periodEnd = isoDate(now);
    const activity = Array.isArray(snapshot?.activity) ? snapshot.activity : [];
    const deals = Array.isArray(snapshot?.deals) ? snapshot.deals : [];
    const customers = Array.isArray(snapshot?.customers) ? snapshot.customers : [];
    const today = Array.isArray(snapshot?.today) ? snapshot.today : [];
    const weeklyEvents = activity.filter((event) => eventInRange(event, periodStart, periodEnd));
    const newCustomerRefs = new Set(weeklyEvents.filter((event) => event.event_type === 'customer.created').map((event) => event.customer_ref));
    const newDealRefs = new Set(weeklyEvents.filter((event) => event.event_type === 'deal.created').map((event) => event.deal_ref));
    const newCustomers = customers.filter((item) => newCustomerRefs.has(item.ref) || (item.updated_at && String(item.updated_at).slice(0, 10) >= periodStart));
    const newDeals = deals.filter((item) => newDealRefs.has(item.ref) || (item.updated_at && String(item.updated_at).slice(0, 10) >= periodStart));
    const stageChanges = weeklyEvents.filter((event) => event.event_type === 'deal.stage_changed');
    const stalledDeals = deals
        .filter((deal) => ['active', 'blocked'].includes(String(deal.status || 'active')) && daysSince(deal.updated_at, now) >= 14)
        .map((deal) => ({ ...deal, stalled_days: daysSince(deal.updated_at, now) }))
        .sort((a, b) => b.stalled_days - a.stalled_days);
    const riskDeals = deals
        .filter((deal) => ['high', 'critical'].includes(String(deal.risk_level)) && !['archived', 'won', 'lost'].includes(String(deal.status)))
        .sort((a, b) => String(a.priority || '').localeCompare(String(b.priority || '')));
    const dealStages = DEAL_STAGES.map((stage) => {
        const items = deals.filter((deal) => String(deal.funnel_stage || 'unknown') === stage);
        return { stage, count: items.length, deals: items };
    }).filter((item) => item.count > 0 || item.stage === 'unknown');
    const actionItems = deals.flatMap((deal) => (deal.actions || []).map((action) => ({ ...action, status: action.status === 'done' ? 'completed' : action.status, deal_title: deal.title, customer_name: deal.customer_name })));
    const actionStatuses = ACTION_STATUSES.map((status) => {
        const items = actionItems.filter((action) => String(action.status || 'planned') === status);
        return { status, count: items.length, actions: items };
    });
    return {
        weekly_review: {
            period_start: periodStart,
            period_end: periodEnd,
            new_customers: newCustomers,
            new_deals: newDeals,
            stage_changes: stageChanges,
            stalled_deals: stalledDeals,
            next_week_actions: today.slice(0, 20),
        },
        risk_deals: riskDeals,
        stalled_deals: stalledDeals,
        deal_lifecycle: { stages: dealStages },
        action_lifecycle: { statuses: actionStatuses },
    };
}
export function operationalViewRows(views, view) {
    if (view === 'weekly')
        return views.weekly_review.next_week_actions;
    if (view === 'risk')
        return views.risk_deals;
    if (view === 'stalled')
        return views.stalled_deals;
    if (view === 'deal-lifecycle')
        return views.deal_lifecycle.stages;
    if (view === 'action-lifecycle')
        return views.action_lifecycle.statuses;
    return [];
}
export function stableEntityId(item) {
    return String(item?.ref || item?.action_ref || item?.id || path.basename(String(item?.title || 'item')));
}
