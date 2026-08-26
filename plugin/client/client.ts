// This client is injected globally by DSH. Every product behavior is gated by
// the route so the default conversation at `/` remains untouched.
export function apply(ctx: any) {
  if (typeof window === 'undefined' || window.location.pathname !== '/dealpilot') return;
  (window as any).__dealpilotRuntime = ctx;
  const start = () => mountDealPilot(ctx);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

const VIEW_TITLES: Record<string, string> = {
  today: '今日工作', customers: '客户', deals: '交易', actions: '跟进任务',
  funnel: '销售漏斗', activity: '活动时间线',
};

const EMPTY_PROMPTS = [
  ['导入客户资料', '请检查当前工作区 sources/inbox 中的客户资料，先告诉我可导入的内容和重复项，不要直接写入。'],
  ['创建第一笔交易', '我想创建第一笔交易。请先询问客户、产品、阶段和下一步行动，不要直接写入。'],
  ['规划今日跟进', '请根据当前销售工作区规划今天的跟进顺序，并区分事实、风险和建议。'],
];

function mountDealPilot(runtime: any) {
  if (document.querySelector('[data-dealpilot-route]')) return;
  document.documentElement.classList.add('dealpilot-route');
  hideNativeWorkspaceControls();

  const panel = document.createElement('aside');
  panel.dataset.dealpilotRoute = 'true';
  panel.className = 'dealpilot-route-panel';
  panel.innerHTML = `
    <div class="dealpilot-brand"><span class="dealpilot-mark">D</span><div><strong>DealPilot</strong><small>销售工作台</small></div></div>
    <div class="dealpilot-workspace-row"><span>工作区</span><strong data-workspace-name>未选择</strong></div>
    <button class="dealpilot-new" data-new-session type="button"><span aria-hidden="true">＋</span> 新建对话</button>
    <div class="dealpilot-section-label">最近对话</div>
    <div class="dealpilot-sessions" data-sessions><span class="dealpilot-session-dot"></span>完成工作区选择后显示</div>
    <button class="dealpilot-change" data-change-workspace type="button">切换工作区</button>`;
  attachDealPilotSidebar(panel, true);

  const contextPanel = document.createElement('aside');
  contextPanel.className = 'dealpilot-context';
  contextPanel.hidden = true;
  contextPanel.innerHTML = `
    <header class="dealpilot-context-header">
      <div><span class="dealpilot-eyebrow">业务上下文</span><strong data-context-workspace>DealPilot</strong></div>
      <div class="dealpilot-icon-actions"><button data-context-refresh type="button" aria-label="刷新业务数据" title="刷新">↻</button><button data-context-collapse type="button" aria-label="收起业务上下文" title="收起">×</button></div>
    </header>
    <div class="dealpilot-context-scroll" data-context-content><div class="dealpilot-loading">正在读取销售工作区...</div></div>`;

  const contextLauncher = document.createElement('button');
  contextLauncher.className = 'dealpilot-context-launcher';
  contextLauncher.type = 'button';
  contextLauncher.hidden = true;
  contextLauncher.setAttribute('aria-label', '打开业务上下文');
  contextLauncher.innerHTML = '<span>D</span><strong>业务上下文</strong>';

  const workbench = document.createElement('section');
  workbench.className = 'dealpilot-workbench';
  workbench.hidden = true;
  workbench.innerHTML = `
    <header class="dealpilot-workbench-header">
      <div><span class="dealpilot-eyebrow">DealPilot</span><h2 data-board-title>今日工作</h2><p data-board-subtitle>聚焦需要推进的销售事项</p></div>
      <div class="dealpilot-icon-actions"><button data-board-refresh type="button" aria-label="刷新业务数据" title="刷新">↻</button><button data-board-close type="button" aria-label="关闭完整工作台" title="关闭">×</button></div>
    </header>
    <nav class="dealpilot-tabs" aria-label="业务视图">${Object.entries(VIEW_TITLES).map(([view, label]) => `<button data-view="${view}" type="button">${label}</button>`).join('')}</nav>
    <div class="dealpilot-workbench-content" data-board-content><div class="dealpilot-loading">加载中...</div></div>`;

  const shade = document.createElement('div');
  shade.className = 'dealpilot-onboarding';
  shade.innerHTML = `
    <div class="dealpilot-onboarding-card">
      <div class="dealpilot-kicker">DEALPILOT SETUP</div><h1>连接你的销售工作区</h1>
      <p>客户、交易和跟进都保存在所选工作区。DealPilot 只会读取和操作这里的数据。</p>
      <div class="dealpilot-setup-steps"><span class="active">1 选择</span><span>2 检测</span><span>3 进入</span></div>
      <label for="dealpilot-workspace-select">工作区</label><select id="dealpilot-workspace-select"><option value="">加载中...</option></select>
      <div class="dealpilot-status" data-status>正在加载工作区...</div>
      <div class="dealpilot-onboarding-actions"><button data-initialize hidden type="button">初始化并进入</button><button data-cancel-workspace hidden type="button">取消</button></div>
    </div>`;

  document.body.append(contextPanel, contextLauncher, workbench, shade);
  const style = document.createElement('style');
  style.dataset.dealpilotProductStyle = 'true';
  style.textContent = productStyles;
  document.head.append(style);
  attachConversationProductUi(contextPanel, contextLauncher, workbench);

  const select = shade.querySelector<HTMLSelectElement>('#dealpilot-workspace-select')!;
  const status = shade.querySelector<HTMLElement>('[data-status]')!;
  const initializeButton = shade.querySelector<HTMLButtonElement>('[data-initialize]')!;
  const cancelButton = shade.querySelector<HTMLButtonElement>('[data-cancel-workspace]')!;
  let selectedId = '';
  let inspection: any;
  let workspaceBeforePicker = '';
  let inspectVersion = 0;
  let snapshot: any;
  let activeView = 'today';
  let selectedItem: any;
  let searchQuery = '';
  let filterValue = 'all';
  let sortValue = 'priority';

  const api = async (url: string, options?: RequestInit) => {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  };
  const setStatus = (text: string, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const setWorkspaceName = (name: string) => {
    panel.querySelector<HTMLElement>('[data-workspace-name]')!.textContent = name;
    contextPanel.querySelector<HTMLElement>('[data-context-workspace]')!.textContent = name;
  };
  const actionRows = () => (snapshot?.deals || []).flatMap((deal: any) => (deal.actions || []).map((action: any) => ({ ...action, deal_title: deal.title, customer_name: deal.customer_name })));
  const sourceForView = (view: string): any[] => {
    if (!snapshot) return [];
    if (view === 'customers') return snapshot.customers || [];
    if (view === 'deals') return snapshot.deals || [];
    if (view === 'actions') return actionRows();
    if (view === 'today') return snapshot.today || [];
    if (view === 'funnel') return snapshot.funnel || [];
    return snapshot.activity || [];
  };
  const itemTitle = (item: any, view: string) => item.title || item.event_type || item.stage || (view === 'activity' ? '业务事件' : '未命名');
  const itemMeta = (item: any, view: string) => {
    if (view === 'customers') return [item.relationship_stage, item.market, item.priority].filter(Boolean).join(' · ');
    if (view === 'deals') return [item.customer_name, item.funnel_stage, item.risk_level].filter(Boolean).join(' · ');
    if (view === 'actions') return [item.customer_name, item.deal_title, item.status, formatDate(item.due_at)].filter(Boolean).join(' · ');
    if (view === 'today') return [item.customer_name, item.deal_title, bucketLabel(item.bucket), formatDate(item.due_at)].filter(Boolean).join(' · ');
    if (view === 'funnel') return `${item.count ?? 0} 笔交易`;
    return [formatDate(item.occurred_at, true), item.channel, item.customer_ref || item.deal_ref].filter(Boolean).join(' · ');
  };
  const itemTone = (item: any, view: string) => {
    if (view === 'today') return item.bucket || 'today';
    if (view === 'deals') return ['high', 'critical'].includes(item.risk_level) ? 'risk' : 'neutral';
    if (view === 'actions') return item.status === 'blocked' ? 'risk' : item.status === 'completed' ? 'done' : 'today';
    return 'neutral';
  };
  const matchesFilter = (item: any, view: string) => {
    if (filterValue === 'all') return true;
    if (view === 'customers') return filterValue === 'priority' ? ['P1', 'high'].includes(item.priority) : item.relationship_stage === filterValue;
    if (view === 'deals') return filterValue === 'risk' ? ['high', 'critical'].includes(item.risk_level) : filterValue === 'active' ? item.status === 'active' : item.funnel_stage === filterValue;
    if (view === 'actions') return filterValue === 'overdue' ? item.status !== 'completed' && item.due_at && Date.parse(item.due_at) < Date.now() : filterValue === 'open' ? !['completed', 'cancelled'].includes(item.status) : item.status === filterValue;
    if (view === 'today') return item.bucket === filterValue;
    return true;
  };
  const priorityRank = (item: any) => ({ critical: 0, high: 1, P1: 1, P2: 2, medium: 2, P3: 3, low: 4 } as Record<string, number>)[item.priority || item.risk_level] ?? 5;
  const sortedRows = (view: string) => sourceForView(view).filter((item) => {
    const haystack = `${itemTitle(item, view)} ${itemMeta(item, view)} ${item.risk_summary || item.reason || ''}`.toLowerCase();
    return (!searchQuery || haystack.includes(searchQuery.toLowerCase())) && matchesFilter(item, view);
  }).sort((a, b) => {
    if (sortValue === 'name') return itemTitle(a, view).localeCompare(itemTitle(b, view), 'zh-CN');
    if (sortValue === 'date') {
      const first = String(a.due_at || a.occurred_at || '');
      const second = String(b.due_at || b.occurred_at || '');
      return view === 'activity' ? second.localeCompare(first) : first.localeCompare(second);
    }
    return priorityRank(a) - priorityRank(b);
  }).slice(0, 100);
  const filterOptions = (view: string) => {
    if (view === 'customers') return [['all', '全部客户'], ['priority', '高优先级'], ['new', '新客户'], ['qualified', '已筛选']];
    if (view === 'deals') return [['all', '全部交易'], ['active', '活跃交易'], ['risk', '高风险'], ...((snapshot?.funnel || []).map((x: any) => [x.stage, x.stage]))];
    if (view === 'actions') return [['all', '全部任务'], ['open', '未完成'], ['overdue', '已逾期'], ['planned', '待安排'], ['in_progress', '进行中'], ['completed', '已完成'], ['blocked', '已阻塞']];
    if (view === 'today') return [['all', '全部事项'], ['overdue', '逾期'], ['today', '今天'], ['risk', '风险'], ['confirmation', '待确认']];
    return [['all', '全部']];
  };
  const promptForItem = (item: any, view: string) => {
    const title = itemTitle(item, view);
    if (view === 'customers') return `请分析客户“${title}”的当前状态，并给出下一步销售建议。引用当前销售工作区的事实，不要猜测未知信息。`;
    if (view === 'deals') return `请分析交易“${title}”（客户：${item.customer_name || '未知'}），重点说明当前风险、漏斗阶段和下一步行动。`;
    if (view === 'actions' || view === 'today') return `请处理跟进任务“${title}”（${item.customer_name || ''} / ${item.deal_title || ''}）。先确认事实，再告诉我是否需要完成、延期或阻塞。`;
    return `请解释这条业务记录，并说明它对当前销售工作的影响：${title}。`;
  };
  const sendToConversation = (prompt: string) => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea:not([disabled]), textarea') || document.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!input) return;
    if (input instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(input, prompt);
      else input.value = prompt;
    } else input.textContent = prompt;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    input.focus();
    closeWorkbench();
  };

  const renderEmptyState = () => `
    <div class="dealpilot-empty-state">
      <span class="dealpilot-empty-mark">D</span><h3>开始建立销售脉络</h3>
      <p>当前工作区还没有客户、交易或跟进。可以从一条对话开始。</p>
      <div class="dealpilot-empty-actions">${EMPTY_PROMPTS.map(([label, prompt]) => `<button data-prompt="${escapeHtml(prompt)}" type="button">${escapeHtml(label)}</button>`).join('')}</div>
    </div>`;

  const renderContext = () => {
    const content = contextPanel.querySelector<HTMLElement>('[data-context-content]')!;
    if (!snapshot) { content.innerHTML = '<div class="dealpilot-loading">正在读取销售工作区...</div>'; return; }
    const s = snapshot.summary || {};
    const today = (snapshot.today || []).slice(0, 4);
    const activity = (snapshot.activity || []).slice(0, 3);
    const isEmpty = !(s.customers || s.active_deals || s.today || activity.length);
    const todayOnly = (snapshot.today || []).filter((item: any) => item.bucket === 'today').length;
    content.innerHTML = `
      <section class="dealpilot-summary" aria-label="销售摘要">
        <button data-summary-view="today" data-filter="overdue" class="tone-overdue" type="button"><b>${s.overdue || 0}</b><span>逾期</span></button>
        <button data-summary-view="today" data-filter="today" class="tone-today" type="button"><b>${todayOnly}</b><span>今天</span></button>
        <button data-summary-view="today" data-filter="risk" class="tone-risk" type="button"><b>${s.risks || 0}</b><span>风险</span></button>
        <button data-summary-view="today" data-filter="confirmation" class="tone-confirmation" type="button"><b>${s.confirmation || 0}</b><span>待确认</span></button>
      </section>
      ${isEmpty ? renderEmptyState() : `
        <section class="dealpilot-context-section"><div class="dealpilot-section-head"><strong>优先处理</strong><button data-open-view="today" type="button">查看全部</button></div>
          <div class="dealpilot-priority-list">${today.length ? today.map((item: any, index: number) => `<button data-context-item="${index}" type="button"><i class="tone-dot tone-${escapeHtml(itemTone(item, 'today'))}"></i><span><strong>${escapeHtml(itemTitle(item, 'today'))}</strong><small>${escapeHtml(itemMeta(item, 'today'))}</small></span></button>`).join('') : '<div class="dealpilot-quiet-state">今天没有必须处理的事项</div>'}</div>
        </section>
        <section class="dealpilot-context-section"><div class="dealpilot-section-head"><strong>最近活动</strong><button data-open-view="activity" type="button">查看全部</button></div>
          <div class="dealpilot-activity-list">${activity.length ? activity.map((item: any) => `<div><span>${escapeHtml(formatDate(item.occurred_at, true))}</span><strong>${escapeHtml(itemTitle(item, 'activity'))}</strong></div>`).join('') : '<div class="dealpilot-quiet-state">暂无业务活动</div>'}</div>
        </section>`}
      <button class="dealpilot-open-workbench" data-open-workbench type="button"><span>打开完整工作台</span><span aria-hidden="true">→</span></button>
      <div class="dealpilot-context-meta"><span>${s.customers || 0} 个客户</span><span>${s.active_deals || 0} 笔活跃交易</span><span>刚刚更新</span></div>`;
    content.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach((button) => button.addEventListener('click', () => sendToConversation(button.dataset.prompt || '')));
    content.querySelectorAll<HTMLButtonElement>('[data-open-view]').forEach((button) => button.addEventListener('click', () => openWorkbench(button.dataset.openView || 'today')));
    content.querySelectorAll<HTMLButtonElement>('[data-summary-view]').forEach((button) => button.addEventListener('click', () => {
      filterValue = button.dataset.filter || 'all';
      openWorkbench(button.dataset.summaryView || 'today', true);
    }));
    content.querySelectorAll<HTMLButtonElement>('[data-context-item]').forEach((button) => button.addEventListener('click', () => {
      selectedItem = (snapshot.today || [])[Number(button.dataset.contextItem)];
      openWorkbench('today', true);
    }));
    content.querySelector<HTMLButtonElement>('[data-open-workbench]')?.addEventListener('click', () => openWorkbench('today'));
  };

  const renderDetail = (item: any, view: string) => {
    const detail = workbench.querySelector<HTMLElement>('[data-board-detail]');
    if (!detail) return;
    if (!item) {
      detail.innerHTML = '<div class="dealpilot-detail-empty"><span>选择一条记录</span><p>在这里查看业务事实和下一步操作。</p></div>';
      return;
    }
    const fields: Array<[string, any]> = [];
    if (view === 'customers') fields.push(['关系阶段', item.relationship_stage], ['市场', item.market], ['ICP', item.icp_fit], ['优先级', item.priority], ['状态', item.status]);
    if (view === 'deals') fields.push(['客户', item.customer_name], ['漏斗阶段', item.funnel_stage], ['风险', item.risk_level], ['优先级', item.priority], ['状态', item.status]);
    if (view === 'actions' || view === 'today') fields.push(['客户', item.customer_name], ['交易', item.deal_title], ['状态', item.status || bucketLabel(item.bucket)], ['到期', formatDate(item.due_at)], ['优先级', item.priority]);
    if (view === 'activity') fields.push(['时间', formatDate(item.occurred_at, true)], ['渠道', item.channel], ['客户引用', item.customer_ref], ['交易引用', item.deal_ref]);
    if (view === 'funnel') fields.push(['阶段', item.stage], ['交易数量', item.count]);
    detail.innerHTML = `
      <div class="dealpilot-detail-head"><span class="dealpilot-status-pill tone-${escapeHtml(itemTone(item, view))}">${escapeHtml(statusLabel(item, view))}</span><h3>${escapeHtml(itemTitle(item, view))}</h3><p>${escapeHtml(item.risk_summary || item.reason || itemMeta(item, view) || '当前工作区中的业务记录')}</p></div>
      <dl>${fields.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || '未知')}</dd></div>`).join('')}</dl>
      <div class="dealpilot-detail-actions"><button data-ask-agent type="button">在对话中分析</button>${view === 'actions' || view === 'today' ? '<button data-action-update type="button">处理这项跟进</button>' : ''}</div>`;
    detail.querySelector('[data-ask-agent]')?.addEventListener('click', () => sendToConversation(promptForItem(item, view)));
    detail.querySelector('[data-action-update]')?.addEventListener('click', () => sendToConversation(promptForItem(item, view)));
  };

  const renderBoard = (view: string) => {
    activeView = view;
    workbench.querySelector<HTMLElement>('[data-board-title]')!.textContent = VIEW_TITLES[view] || '销售工作台';
    workbench.querySelector<HTMLElement>('[data-board-subtitle]')!.textContent = boardSubtitle(view, snapshot);
    workbench.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    const content = workbench.querySelector<HTMLElement>('[data-board-content]')!;
    if (!snapshot) { content.innerHTML = '<div class="dealpilot-loading">正在读取业务数据...</div>'; return; }
    const options = filterOptions(view).map(([value, label]) => `<option value="${escapeHtml(value)}"${value === filterValue ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
    content.innerHTML = `
      <div class="dealpilot-board-toolbar">
        <label class="dealpilot-search"><span aria-hidden="true">⌕</span><input data-board-search type="search" aria-label="搜索当前视图" placeholder="搜索${escapeHtml(VIEW_TITLES[view])}" value="${escapeHtml(searchQuery)}"></label>
        <select data-board-filter aria-label="筛选当前视图">${options}</select>
        <select data-board-sort aria-label="排序当前视图"><option value="priority"${sortValue === 'priority' ? ' selected' : ''}>优先级</option><option value="name"${sortValue === 'name' ? ' selected' : ''}>名称</option><option value="date"${sortValue === 'date' ? ' selected' : ''}>日期</option></select>
      </div>
      ${view === 'funnel' ? renderFunnel(snapshot.funnel || []) : ''}
      <div class="dealpilot-board-layout"><div class="dealpilot-board-list" data-board-list></div><aside class="dealpilot-board-detail" data-board-detail></aside></div>`;
    const rows = sortedRows(view);
    const list = content.querySelector<HTMLElement>('[data-board-list]')!;
    list.innerHTML = rows.length ? rows.map((item: any, index: number) => `
      <button class="dealpilot-board-item${selectedItem === item ? ' selected' : ''}" data-item-index="${index}" type="button"><i class="tone-dot tone-${escapeHtml(itemTone(item, view))}"></i><span><strong>${escapeHtml(itemTitle(item, view))}</strong><small>${escapeHtml(itemMeta(item, view))}</small></span><span class="dealpilot-row-arrow" aria-hidden="true">›</span></button>`).join('') : renderEmptyState();
    list.querySelectorAll<HTMLButtonElement>('[data-item-index]').forEach((node) => node.addEventListener('click', () => { selectedItem = sortedRows(view)[Number(node.dataset.itemIndex)]; renderBoard(view); }));
    list.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach((button) => button.addEventListener('click', () => sendToConversation(button.dataset.prompt || '')));
    content.querySelector<HTMLInputElement>('[data-board-search]')?.addEventListener('input', (event) => { searchQuery = (event.target as HTMLInputElement).value; selectedItem = undefined; renderBoard(view); });
    content.querySelector<HTMLSelectElement>('[data-board-filter]')?.addEventListener('change', (event) => { filterValue = (event.target as HTMLSelectElement).value; selectedItem = undefined; renderBoard(view); });
    content.querySelector<HTMLSelectElement>('[data-board-sort]')?.addEventListener('change', (event) => { sortValue = (event.target as HTMLSelectElement).value; renderBoard(view); });
    renderDetail(selectedItem, view);
  };

  const refreshSnapshot = async () => {
    if (!selectedId) return;
    snapshot = await api(`/api/dealpilot/snapshot?workspaceId=${encodeURIComponent(selectedId)}`);
    renderContext();
    if (!workbench.hidden) renderBoard(activeView);
  };
  const openWorkbench = (view: string, preserveState = false) => {
    if (!preserveState) { selectedItem = undefined; searchQuery = ''; filterValue = 'all'; sortValue = view === 'activity' ? 'date' : 'priority'; }
    workbench.hidden = false;
    contextPanel.hidden = true;
    contextLauncher.hidden = true;
    document.body.classList.add('dealpilot-workbench-open');
    renderBoard(view);
  };
  function closeWorkbench() {
    workbench.hidden = true;
    document.body.classList.remove('dealpilot-workbench-open');
    if (document.body.classList.contains('dealpilot-context-collapsed')) contextLauncher.hidden = false;
    else contextPanel.hidden = false;
  }

  const getSessions = () => { try { return runtime?.get?.('sessions'); } catch { return undefined; } };
  const createNativeSession = async (workspaceId: string) => {
    const sessions = getSessions();
    const create = sessions?.manager?.api?.sessions?.create;
    if (typeof create !== 'function') return '';
    const response = await create({ workspaceId, agentPreset: 'dealpilot-sales' });
    const result = response?.result;
    if (!result?.ok) throw new Error(result?.error?.message || '无法创建 DealPilot 对话');
    const id = result.value?.sessionId || '';
    if (id && sessions.manager?.refresh) await sessions.manager.refresh();
    if (id && sessions.manager?.select) sessions.manager.select(id);
    return id;
  };
  const enterReadyState = async (session: any, fallbackName: string) => {
    shade.hidden = true;
    cancelButton.hidden = true;
    setWorkspaceName(session.workspaceName || inspection?.name || fallbackName);
    panel.querySelector<HTMLElement>('[data-sessions]')!.innerHTML = '<span class="dealpilot-session-dot active"></span>当前对话';
    document.body.classList.add('dealpilot-ready');
    contextPanel.hidden = false;
    contextLauncher.hidden = true;
    await refreshSnapshot();
  };
  const bindSession = async (workspaceId: string) => {
    let dshSessionId = '';
    try { dshSessionId = await createNativeSession(workspaceId); }
    catch (err) { console.warn('[dealpilot] native session binding unavailable', err); }
    const session = await api('/api/dealpilot/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, dshSessionId: dshSessionId || undefined }) });
    sessionStorage.setItem('dealpilot.sessionId', session.sessionId);
    sessionStorage.setItem('dealpilot.workspaceId', workspaceId);
    await enterReadyState(session, workspaceId);
  };
  const restoreSession = async (workspaceId: string) => {
    const savedId = sessionStorage.getItem('dealpilot.sessionId');
    if (!savedId) return false;
    try {
      const session = await api(`/api/dealpilot/session/${encodeURIComponent(savedId)}`);
      if (session.workspaceId !== workspaceId || session.agentPreset !== 'dealpilot-sales') return false;
      const sessions = getSessions();
      if (sessions?.manager?.select) sessions.manager.select(savedId);
      await enterReadyState(session, workspaceId);
      return true;
    } catch { return false; }
  };
  const inspect = async (id: string) => {
    const version = ++inspectVersion;
    selectedId = id;
    initializeButton.hidden = true;
    if (!id) { setStatus('请选择一个工作区'); return; }
    setStatus('正在检测 DealPilot 数据...');
    try {
      inspection = await api('/api/dealpilot/workspaces/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: id }) });
      if (version !== inspectVersion) return;
      if (inspection.status === 'new') { setStatus('这是一个新工作区。初始化只会创建 DealPilot 所需目录，不会覆盖现有文件。'); initializeButton.hidden = false; return; }
      setStatus('已检测到现有销售资料，正在进入...');
      if (!(await restoreSession(id)) && version === inspectVersion) await bindSession(id);
    } catch (err: any) { if (version === inspectVersion) setStatus(err.message, true); }
  };
  const load = async () => {
    try {
      const data = await api('/api/dealpilot/workspaces');
      select.innerHTML = '<option value="">选择工作区</option>' + (data.workspaces || []).map((w: any) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join('');
      const saved = sessionStorage.getItem('dealpilot.workspaceId');
      if (saved && (data.workspaces || []).some((w: any) => w.id === saved)) { select.value = saved; await inspect(saved); }
      else setStatus('选择一个已有工作区，或选择空工作区后初始化');
    } catch (err: any) { setStatus(`工作区加载失败：${err.message}`, true); }
  };

  select.addEventListener('change', () => inspect(select.value));
  initializeButton.addEventListener('click', async () => {
    initializeButton.disabled = true; setStatus('正在初始化 DealPilot...');
    try { await api('/api/dealpilot/workspaces/initialize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: selectedId }) }); await bindSession(selectedId); }
    catch (err: any) { setStatus(err.message, true); }
    finally { initializeButton.disabled = false; }
  });
  panel.querySelector('[data-change-workspace]')!.addEventListener('click', () => {
    workspaceBeforePicker = selectedId;
    cancelButton.hidden = false;
    shade.hidden = false;
    select.value = selectedId;
    setStatus('选择另一个工作区；取消会保留当前工作区');
  });
  cancelButton.addEventListener('click', () => {
    inspectVersion += 1;
    selectedId = workspaceBeforePicker || selectedId;
    select.value = selectedId;
    cancelButton.hidden = true;
    shade.hidden = true;
    setStatus('已保留当前工作区');
  });
  panel.querySelector('[data-new-session]')!.addEventListener('click', async () => {
    if (!selectedId) return;
    const button = panel.querySelector<HTMLButtonElement>('[data-new-session]')!;
    button.disabled = true;
    try {
      const nativeId = await createNativeSession(selectedId);
      const created = await api('/api/dealpilot/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: selectedId, dshSessionId: nativeId }) });
      sessionStorage.setItem('dealpilot.sessionId', created.sessionId);
      panel.querySelector<HTMLElement>('[data-sessions]')!.innerHTML = '<span class="dealpilot-session-dot active"></span>新对话';
    } catch (err) { console.warn('[dealpilot] new conversation failed', err); }
    finally { button.disabled = false; }
  });
  contextPanel.querySelector('[data-context-refresh]')!.addEventListener('click', () => void refreshSnapshot());
  contextPanel.querySelector('[data-context-collapse]')!.addEventListener('click', () => {
    contextPanel.hidden = true;
    contextLauncher.hidden = false;
    document.body.classList.add('dealpilot-context-collapsed');
  });
  contextLauncher.addEventListener('click', () => {
    contextPanel.hidden = false;
    contextLauncher.hidden = true;
    document.body.classList.remove('dealpilot-context-collapsed');
  });
  workbench.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => {
    selectedItem = undefined; searchQuery = ''; filterValue = 'all'; sortValue = button.dataset.view === 'activity' ? 'date' : 'priority';
    renderBoard(button.dataset.view || 'today');
  }));
  workbench.querySelector('[data-board-refresh]')!.addEventListener('click', () => void refreshSnapshot());
  workbench.querySelector('[data-board-close]')!.addEventListener('click', closeWorkbench);

  const nativeObserver = new MutationObserver(() => {
    hideNativeWorkspaceControls();
    attachDealPilotSidebar(panel);
    attachConversationProductUi(contextPanel, contextLauncher, workbench);
  });
  nativeObserver.observe(document.body, { childList: true, subtree: true });
  load();
}

function attachConversationProductUi(contextPanel: HTMLElement, launcher: HTMLElement, workbench: HTMLElement) {
  const conversation = document.querySelector<HTMLElement>('[data-pane="conversation"], [class*="centerCol"]');
  if (!conversation) return;
  conversation.classList.add('dealpilot-conversation-host');
  for (const element of [contextPanel, launcher, workbench]) if (!conversation.contains(element)) conversation.append(element);
}

function attachDealPilotSidebar(panel: HTMLElement, ensureExpanded = false) {
  const sidebar = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]');
  const workspaceSlot = sidebar?.querySelector<HTMLElement>('[data-slot="sidebar.workspaces"]');
  const region = workspaceSlot?.parentElement;
  if (!sidebar || !workspaceSlot || !region) {
    if (!panel.isConnected) document.body.append(panel);
    return;
  }
  workspaceSlot.classList.add('dealpilot-native-workspaces-hidden');
  sidebar.querySelector<HTMLElement>('button[class*="newSession"]')?.classList.add('dealpilot-native-new-session-hidden');
  if (!region.contains(panel)) region.append(panel);
  if (ensureExpanded) sidebar.querySelector<HTMLButtonElement>('button[aria-label="打开侧边栏"]')?.click();
}

function hideNativeWorkspaceControls() {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [data-testid], [aria-label]'));
  for (const element of candidates) {
    if (element.textContent?.trim().match(/^(Workspace|工作区|Workspaces|工作空间)$/i) || element.getAttribute('aria-label')?.match(/workspace|工作区/i)) {
      (element.closest('button, [role="button"], [data-testid]') || element).classList.add('dealpilot-native-hidden');
    }
  }
  if (!document.querySelector('style[data-dealpilot-native-style]')) {
    const style = document.createElement('style');
    style.dataset.dealpilotNativeStyle = 'true';
    style.textContent = '.dealpilot-native-hidden,.dealpilot-native-workspaces-hidden,.dealpilot-native-new-session-hidden{display:none!important}.dealpilot-route body:not(.dealpilot-ready) textarea,.dealpilot-route body:not(.dealpilot-ready) [contenteditable="true"]{pointer-events:none!important}';
    document.head.append(style);
  }
}

function renderFunnel(items: any[]): string {
  const visible = items.filter((item) => Number(item.count || 0) > 0);
  if (!visible.length) return '';
  const max = Math.max(1, ...visible.map((item) => Number(item.count || 0)));
  return `<section class="dealpilot-funnel"><div class="dealpilot-section-head"><strong>阶段分布</strong><span>${visible.reduce((sum, item) => sum + Number(item.count || 0), 0)} 笔活跃交易</span></div>${visible.map((item) => `<div><span>${escapeHtml(item.stage)}</span><i><b style="width:${Math.max(6, Number(item.count || 0) / max * 100)}%"></b></i><strong>${escapeHtml(item.count)}</strong></div>`).join('')}</section>`;
}

function boardSubtitle(view: string, snapshot: any): string {
  const count = view === 'customers' ? snapshot?.summary?.customers : view === 'deals' ? snapshot?.summary?.active_deals : view === 'today' ? snapshot?.summary?.today : undefined;
  const copy: Record<string, string> = { today: '聚焦需要推进的销售事项', customers: '管理客户关系、市场和优先级', deals: '掌握阶段、风险和下一步行动', actions: '安排、推进和完成跟进', funnel: '查看活跃交易的阶段分布', activity: '追踪最近的业务变化' };
  return `${copy[view] || '当前销售工作区'}${count !== undefined ? ` · ${count} 条` : ''}`;
}

function bucketLabel(value: string): string {
  return ({ overdue: '逾期', today: '今天', risk: '风险', confirmation: '待确认' } as Record<string, string>)[value] || value || '进行中';
}

function statusLabel(item: any, view: string): string {
  if (view === 'today') return bucketLabel(item.bucket);
  if (view === 'deals') return ['high', 'critical'].includes(item.risk_level) ? '高风险' : item.funnel_stage || '交易';
  if (view === 'actions') return item.status === 'completed' ? '已完成' : item.status === 'blocked' ? '已阻塞' : '待跟进';
  if (view === 'customers') return item.priority || item.relationship_stage || '客户';
  if (view === 'funnel') return '漏斗阶段';
  return item.channel || '业务活动';
}

function formatDate(value: any, includeTime = false): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', includeTime ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' }).format(date);
}

function escapeHtml(value: any): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[char]);
}

const productStyles = `
  .dealpilot-route-panel{position:relative;z-index:1;width:auto;height:100%;min-height:0;padding:12px 10px 10px;color:#20242a;font:13px/1.4 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;flex-direction:column;gap:12px;overflow:auto;background:transparent;border:0;box-shadow:none;letter-spacing:0}
  .dealpilot-brand{display:flex;align-items:center;gap:9px;padding:2px}.dealpilot-mark{width:28px;height:28px;border-radius:6px;background:#1d2630;color:#fff;display:grid;place-items:center;font-weight:700}.dealpilot-brand strong{display:block;font-size:14px}.dealpilot-brand small{display:block;color:#818892;font-size:10px;margin-top:1px}
  .dealpilot-workspace-row{padding:8px 2px;border-top:1px solid #e7e9ec;border-bottom:1px solid #e7e9ec}.dealpilot-workspace-row span{display:block;color:#8a9098;font-size:10px}.dealpilot-workspace-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;font-size:12px}
  .dealpilot-new,.dealpilot-change{width:100%;height:34px;border:0;border-radius:5px;cursor:pointer;font:inherit}.dealpilot-new{padding:0 10px;text-align:left;background:#1d67d6;color:#fff;font-weight:600}.dealpilot-new:disabled{opacity:.5}.dealpilot-section-label{color:#8b929b;font-size:10px;text-transform:uppercase;margin-top:2px}.dealpilot-sessions{display:flex;align-items:center;gap:7px;color:#5d6671;font-size:12px;padding:6px 4px}.dealpilot-session-dot{width:6px;height:6px;border-radius:50%;background:#bec4ca}.dealpilot-session-dot.active{background:#16835b}.dealpilot-change{margin-top:auto;text-align:left;padding:0 8px;background:transparent;color:#6b737d;font-size:11px}.dealpilot-change:hover{background:#f0f2f4}
  .dealpilot-conversation-host{position:relative!important;box-sizing:border-box!important;padding-right:340px!important;transition:padding-right .18s ease}.dealpilot-context{position:absolute;z-index:30;right:0;top:0;bottom:0;width:340px;background:#fbfcfd;border-left:1px solid #e1e5e9;color:#22272e;font:13px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}.dealpilot-context[hidden],.dealpilot-context-launcher[hidden],.dealpilot-workbench[hidden]{display:none!important}
  .dealpilot-context-header{height:64px;padding:0 16px;border-bottom:1px solid #e4e7ea;display:flex;align-items:center;justify-content:space-between;background:#fff}.dealpilot-context-header strong{display:block;font-size:14px;margin-top:2px}.dealpilot-eyebrow{display:block;color:#868d96;font-size:10px;text-transform:uppercase}.dealpilot-icon-actions{display:flex;gap:5px}.dealpilot-icon-actions button{width:29px;height:29px;border:1px solid #dce1e6;border-radius:5px;background:#fff;color:#5d6671;font:17px/1 sans-serif;cursor:pointer}.dealpilot-icon-actions button:hover{border-color:#9ea7b1;color:#20262d}.dealpilot-context-scroll{height:calc(100% - 64px);overflow:auto;padding:0 16px 16px}.dealpilot-loading{padding:48px 16px;color:#7e858e;text-align:center}
  .dealpilot-summary{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #e5e8eb;margin:0 -16px}.dealpilot-summary button{height:76px;border:0;border-right:1px solid #e5e8eb;background:#fff;cursor:pointer;text-align:center}.dealpilot-summary button:last-child{border-right:0}.dealpilot-summary b{display:block;font-size:20px;line-height:1.1}.dealpilot-summary span{display:block;color:#777f88;font-size:10px;margin-top:6px}.dealpilot-summary .tone-overdue b{color:#b42318}.dealpilot-summary .tone-today b{color:#1769a3}.dealpilot-summary .tone-risk b{color:#b65b13}.dealpilot-summary .tone-confirmation b{color:#6750a4}.dealpilot-summary button:hover{background:#f6f8fa}
  .dealpilot-context-section{padding:17px 0;border-bottom:1px solid #e5e8eb}.dealpilot-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.dealpilot-section-head strong{font-size:12px}.dealpilot-section-head button{border:0;background:none;color:#65707b;font:11px inherit;cursor:pointer}.dealpilot-section-head button:hover{color:#1769d2}
  .dealpilot-priority-list{display:flex;flex-direction:column}.dealpilot-priority-list>button{display:grid;grid-template-columns:8px 1fr;gap:9px;align-items:start;border:0;border-radius:5px;background:transparent;text-align:left;padding:8px 5px;cursor:pointer}.dealpilot-priority-list>button:hover{background:#f0f3f6}.dealpilot-priority-list span{min-width:0}.dealpilot-priority-list strong{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dealpilot-priority-list small{display:block;color:#7b838c;font-size:10px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tone-dot{display:block;width:7px;height:7px;border-radius:50%;background:#9ba3ac;margin-top:5px}.tone-dot.tone-overdue{background:#c93b31}.tone-dot.tone-risk{background:#d27224}.tone-dot.tone-today{background:#2d78a6}.tone-dot.tone-confirmation{background:#7357aa}.tone-dot.tone-done{background:#24815f}.dealpilot-activity-list{display:flex;flex-direction:column;gap:9px}.dealpilot-activity-list div{display:grid;grid-template-columns:58px 1fr;gap:8px}.dealpilot-activity-list span{color:#8a9199;font-size:10px}.dealpilot-activity-list strong{font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dealpilot-quiet-state{padding:14px 4px;color:#8a9199;font-size:11px}
  .dealpilot-open-workbench{width:100%;height:38px;margin-top:16px;padding:0 11px;display:flex;align-items:center;justify-content:space-between;border:1px solid #ccd3da;border-radius:5px;background:#fff;color:#27313a;font:12px inherit;font-weight:600;cursor:pointer}.dealpilot-open-workbench:hover{border-color:#74818d;background:#f7f9fa}.dealpilot-context-meta{display:flex;flex-wrap:wrap;gap:5px 10px;color:#9298a0;font-size:9px;padding:10px 2px}
  .dealpilot-empty-state{text-align:center;padding:38px 18px}.dealpilot-empty-mark{display:grid;place-items:center;width:32px;height:32px;margin:0 auto 12px;border-radius:6px;background:#25313b;color:#fff;font-weight:700}.dealpilot-empty-state h3{font-size:14px;margin:0 0 6px}.dealpilot-empty-state p{color:#777f88;font-size:11px;margin:0 auto 16px;max-width:260px}.dealpilot-empty-actions{display:flex;flex-direction:column;gap:6px}.dealpilot-empty-actions button{min-height:34px;border:1px solid #dce1e5;border-radius:5px;background:#fff;color:#36404a;font:11px inherit;cursor:pointer}.dealpilot-empty-actions button:hover{border-color:#8aa4bd;background:#f5f8fa}
  .dealpilot-context-launcher{position:absolute;z-index:29;right:10px;top:12px;height:34px;padding:0 10px;border:1px solid #d7dce1;border-radius:5px;background:#fff;color:#35404a;display:flex;align-items:center;gap:7px;font:11px Inter,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(20,30,40,.08)}.dealpilot-context-launcher span{width:19px;height:19px;border-radius:4px;background:#25313b;color:#fff;display:grid;place-items:center;font-size:10px}.dealpilot-context-collapsed .dealpilot-conversation-host{padding-right:0!important}
  .dealpilot-workbench{position:absolute;z-index:40;inset:0;background:#f7f8fa;color:#22272e;font:13px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;letter-spacing:0}.dealpilot-workbench-open .dealpilot-conversation-host{padding-right:0!important}.dealpilot-workbench-header{height:78px;padding:0 24px;background:#fff;border-bottom:1px solid #e3e6e9;display:flex;align-items:center;justify-content:space-between}.dealpilot-workbench-header h2{display:inline-block;font-size:20px;line-height:1.2;margin:3px 0 0}.dealpilot-workbench-header p{display:inline-block;color:#7b838c;font-size:11px;margin:0 0 0 10px}
  .dealpilot-tabs{height:44px;padding:0 24px;display:flex;gap:22px;background:#fff;border-bottom:1px solid #e3e6e9;overflow-x:auto}.dealpilot-tabs button{height:44px;flex:none;border:0;border-bottom:2px solid transparent;background:transparent;color:#68717b;font:12px inherit;cursor:pointer}.dealpilot-tabs button.active{border-bottom-color:#1f6dc8;color:#1d2630;font-weight:600}.dealpilot-workbench-content{height:calc(100% - 122px);padding:18px 24px 24px;overflow:auto}
  .dealpilot-board-toolbar{display:grid;grid-template-columns:minmax(200px,1fr) 150px 120px;gap:8px;margin-bottom:14px}.dealpilot-search{height:36px;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px solid #d9dee3;border-radius:5px;background:#fff;color:#7d858e}.dealpilot-search input{width:100%;border:0;outline:0;background:transparent;font:12px inherit;color:#2d343b}.dealpilot-board-toolbar select{height:36px;border:1px solid #d9dee3;border-radius:5px;background:#fff;padding:0 9px;color:#414a53;font:11px inherit}
  .dealpilot-board-layout{display:grid;grid-template-columns:minmax(300px,.9fr) minmax(320px,1.1fr);min-height:420px;border:1px solid #e1e5e8;border-radius:6px;background:#fff;overflow:hidden}.dealpilot-board-list{padding:8px;min-width:0;border-right:1px solid #e5e8eb}.dealpilot-board-item{width:100%;min-height:58px;display:grid;grid-template-columns:8px 1fr 14px;gap:10px;align-items:center;border:0;border-bottom:1px solid #edf0f2;background:#fff;text-align:left;padding:10px 8px;cursor:pointer}.dealpilot-board-item:last-child{border-bottom:0}.dealpilot-board-item:hover,.dealpilot-board-item.selected{background:#f3f6f8}.dealpilot-board-item.selected{box-shadow:inset 2px 0 #246fbf}.dealpilot-board-item span{min-width:0}.dealpilot-board-item strong{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dealpilot-board-item small{display:block;color:#7a828b;font-size:10px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dealpilot-row-arrow{color:#a3a9b0;font-size:18px}
  .dealpilot-board-detail{min-width:0;padding:24px;overflow:auto}.dealpilot-detail-empty{height:100%;min-height:320px;display:grid;place-content:center;text-align:center;color:#8b929a}.dealpilot-detail-empty span{font-size:13px}.dealpilot-detail-empty p{font-size:11px;margin:5px 0}.dealpilot-detail-head{padding-bottom:18px;border-bottom:1px solid #e7eaed}.dealpilot-status-pill{display:inline-block;border-radius:4px;padding:3px 6px;background:#edf0f2;color:#5f6871;font-size:9px}.dealpilot-status-pill.tone-overdue{background:#fdeceb;color:#a82d24}.dealpilot-status-pill.tone-risk{background:#fff0e3;color:#a45111}.dealpilot-status-pill.tone-today{background:#eaf3f8;color:#236c95}.dealpilot-status-pill.tone-confirmation{background:#f0ecf8;color:#664e96}.dealpilot-status-pill.tone-done{background:#e8f5ef;color:#217456}.dealpilot-detail-head h3{font-size:19px;margin:9px 0 5px}.dealpilot-detail-head p{color:#747c85;font-size:11px;margin:0}
  .dealpilot-board-detail dl{margin:18px 0}.dealpilot-board-detail dl div{display:grid;grid-template-columns:90px 1fr;padding:9px 0;border-bottom:1px solid #eef0f2}.dealpilot-board-detail dt{color:#8a9199;font-size:10px}.dealpilot-board-detail dd{margin:0;color:#343c44;font-size:11px}.dealpilot-detail-actions{display:flex;gap:7px;margin-top:18px}.dealpilot-detail-actions button{height:34px;padding:0 11px;border:1px solid #cfd6dc;border-radius:5px;background:#fff;color:#2e3943;font:11px inherit;cursor:pointer}.dealpilot-detail-actions button:first-child{background:#216bc1;border-color:#216bc1;color:#fff}
  .dealpilot-funnel{margin-bottom:14px;padding:14px 16px;border:1px solid #e1e5e8;border-radius:6px;background:#fff}.dealpilot-funnel>.dealpilot-section-head span{color:#858d96;font-size:10px}.dealpilot-funnel>div:not(.dealpilot-section-head){display:grid;grid-template-columns:110px 1fr 28px;gap:10px;align-items:center;margin:9px 0;font-size:10px}.dealpilot-funnel i{height:7px;background:#edf0f2;border-radius:3px;overflow:hidden}.dealpilot-funnel i b{display:block;height:100%;background:#397d8e;border-radius:3px}.dealpilot-funnel>div>strong{text-align:right;font-size:11px}
  .dealpilot-onboarding{position:fixed;z-index:2147482999;inset:0;background:rgba(244,246,247,.96);display:grid;place-items:center;padding:24px}.dealpilot-onboarding[hidden]{display:none}.dealpilot-onboarding-card{width:min(460px,100%);background:#fff;border:1px solid #dfe3e7;border-radius:8px;padding:30px;box-shadow:0 16px 45px rgba(18,28,38,.12)}.dealpilot-kicker{font-size:10px;color:#1f6dc8;font-weight:700}.dealpilot-onboarding h1{font-size:24px;margin:7px 0}.dealpilot-onboarding p{margin:0 0 18px;color:#69727b;font-size:12px;line-height:1.6}.dealpilot-setup-steps{display:grid;grid-template-columns:repeat(3,1fr);margin-bottom:20px;border-bottom:1px solid #e3e6e9}.dealpilot-setup-steps span{padding:7px 0;color:#9aa0a7;font-size:10px}.dealpilot-setup-steps span.active{color:#1f6dc8;border-bottom:2px solid #1f6dc8}.dealpilot-onboarding label{display:block;font-size:11px;color:#5f6871;margin-bottom:6px}.dealpilot-onboarding select{width:100%;height:40px;border:1px solid #d4dae0;border-radius:5px;padding:0 10px;background:#fff;font:12px inherit}.dealpilot-status{min-height:42px;padding:11px 0;color:#6e7680;font-size:11px;line-height:1.5}.dealpilot-status.error{color:#b42318}.dealpilot-onboarding-actions{display:flex;gap:8px}.dealpilot-onboarding-actions button{flex:1;height:38px;border:0;border-radius:5px;cursor:pointer;font:12px inherit;font-weight:600}.dealpilot-onboarding-card button[data-initialize]{background:#1f6dc8;color:#fff}.dealpilot-onboarding-card button[data-cancel-workspace]{background:#eef0f2;color:#59616a}
  @media(max-width:1050px){.dealpilot-conversation-host{padding-right:300px!important}.dealpilot-context{width:300px}.dealpilot-workbench-header{padding:0 16px}.dealpilot-workbench-content,.dealpilot-tabs{padding-left:16px;padding-right:16px}.dealpilot-board-layout{grid-template-columns:minmax(240px,.85fr) minmax(270px,1.15fr)}}
  @media(max-width:820px){.dealpilot-conversation-host{padding-right:0!important}.dealpilot-context{width:min(360px,100%);box-shadow:-8px 0 24px rgba(20,30,40,.12)}.dealpilot-board-layout{grid-template-columns:1fr}.dealpilot-board-list{border-right:0}.dealpilot-board-detail{border-top:1px solid #e5e8eb}.dealpilot-board-toolbar{grid-template-columns:1fr 130px}.dealpilot-board-toolbar select:last-child{display:none}}
  @media(max-width:560px){.dealpilot-workbench-header{height:70px}.dealpilot-workbench-header p{display:none}.dealpilot-tabs{padding:0 12px;gap:16px}.dealpilot-workbench-content{height:calc(100% - 114px);padding:12px}.dealpilot-board-toolbar{grid-template-columns:1fr}.dealpilot-board-toolbar select:last-child{display:block}.dealpilot-board-layout{border-left:0;border-right:0;border-radius:0}.dealpilot-onboarding-card{padding:22px}}
`;
