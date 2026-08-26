import * as path from 'node:path';

export interface WeeklyReview {
  period_start: string;
  period_end: string;
  new_customers: any[];
  new_deals: any[];
  stage_changes: any[];
  stalled_deals: any[];
  next_week_actions: any[];
}

export interface OperationalViews {
  weekly_review: WeeklyReview;
  risk_deals: any[];
  stalled_deals: any[];
  deal_lifecycle: { stages: Array<{ stage: string; count: number; deals: any[] }> };
  action_lifecycle: { statuses: Array<{ status: string; count: number; actions: any[] }> };
}

const DEAL_STAGES = ['new', 'qualified', 'contacted', 'replied', 'opportunity', 'quoted', 'sample', 'negotiation', 'won', 'lost', 'unknown'];
const ACTION_STATUSES = ['planned', 'active', 'blocked', 'completed', 'cancelled'];

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function startOfWeek(now: Date): Date {
  const date = new Date(now);
  const day = date.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - offset);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function eventInRange(event: any, start: string, end: string): boolean {
  const occurred = String(event?.occurred_at || '').slice(0, 10);
  return occurred >= start && occurred <= end;
}

function daysSince(value: string | undefined, now: Date): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - time) / 86400000));
}

export function buildOperationalViews(snapshot: any, now = new Date()): OperationalViews {
  const weekStart = startOfWeek(now);
  const periodStart = isoDate(weekStart);
  const periodEnd = isoDate(now);
  const activity = Array.isArray(snapshot?.activity) ? snapshot.activity : [];
  const deals = Array.isArray(snapshot?.deals) ? snapshot.deals : [];
  const customers = Array.isArray(snapshot?.customers) ? snapshot.customers : [];
  const today = Array.isArray(snapshot?.today) ? snapshot.today : [];

  const weeklyEvents = activity.filter((event: any) => eventInRange(event, periodStart, periodEnd));
  const newCustomerRefs = new Set(weeklyEvents.filter((event: any) => event.event_type === 'customer.created').map((event: any) => event.customer_ref));
  const newDealRefs = new Set(weeklyEvents.filter((event: any) => event.event_type === 'deal.created').map((event: any) => event.deal_ref));
  const newCustomers = customers.filter((item: any) => newCustomerRefs.has(item.ref) || (item.updated_at && String(item.updated_at).slice(0, 10) >= periodStart));
  const newDeals = deals.filter((item: any) => newDealRefs.has(item.ref) || (item.updated_at && String(item.updated_at).slice(0, 10) >= periodStart));
  const stageChanges = weeklyEvents.filter((event: any) => event.event_type === 'deal.stage_changed');

  const stalledDeals = deals
    .filter((deal: any) => ['active', 'blocked'].includes(String(deal.status || 'active')) && daysSince(deal.updated_at, now) >= 14)
    .map((deal: any) => ({ ...deal, stalled_days: daysSince(deal.updated_at, now) }))
    .sort((a: any, b: any) => b.stalled_days - a.stalled_days);
  const riskDeals = deals
    .filter((deal: any) => ['high', 'critical'].includes(String(deal.risk_level)) && !['archived', 'won', 'lost'].includes(String(deal.status)))
    .sort((a: any, b: any) => String(a.priority || '').localeCompare(String(b.priority || '')));

  const dealStages = DEAL_STAGES.map((stage) => {
    const items = deals.filter((deal: any) => String(deal.funnel_stage || 'unknown') === stage);
    return { stage, count: items.length, deals: items };
  }).filter((item) => item.count > 0 || item.stage === 'unknown');
  const actionItems = deals.flatMap((deal: any) => (deal.actions || []).map((action: any) => ({ ...action, status: action.status === 'done' ? 'completed' : action.status, deal_title: deal.title, customer_name: deal.customer_name })));
  const actionStatuses = ACTION_STATUSES.map((status) => {
    const items = actionItems.filter((action: any) => String(action.status || 'planned') === status);
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

export function operationalViewRows(views: OperationalViews, view: string): any[] {
  if (view === 'weekly') return views.weekly_review.next_week_actions;
  if (view === 'risk') return views.risk_deals;
  if (view === 'stalled') return views.stalled_deals;
  if (view === 'deal-lifecycle') return views.deal_lifecycle.stages;
  if (view === 'action-lifecycle') return views.action_lifecycle.statuses;
  return [];
}

export function stableEntityId(item: any): string {
  return String(item?.ref || item?.action_ref || item?.id || path.basename(String(item?.title || 'item')));
}
