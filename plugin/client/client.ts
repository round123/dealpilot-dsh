// The host injects this module on every web page. All DealPilot behavior is
// deliberately gated by pathname so the default DSH conversation stays clean.
export function apply(ctx: any) {
  if (typeof window === 'undefined' || window.location.pathname !== '/dealpilot') return;
  (window as any).__dealpilotRuntime = ctx;
  const start = () => mountDealPilot(ctx);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

function mountDealPilot(runtime: any) {
  if (document.querySelector('[data-dealpilot-route]')) return;
  document.documentElement.classList.add('dealpilot-route');
  hideNativeWorkspaceControls();

  const panel = document.createElement('aside');
  panel.dataset.dealpilotRoute = 'true';
  panel.className = 'dealpilot-route-panel';
  panel.innerHTML = `
    <div class="dealpilot-brand"><span class="dealpilot-mark">D</span><div><strong>DealPilot</strong><small>销售工作台</small></div></div>
    <div class="dealpilot-current"><span>当前工作区</span><strong data-workspace-name>未选择</strong></div>
    <button class="dealpilot-new" data-new-session type="button">＋ 新建对话</button>
    <div class="dealpilot-section-label">最近对话</div><div class="dealpilot-sessions" data-sessions>完成工作区选择后显示</div>
    <nav class="dealpilot-nav" aria-label="业务视图">
      <button data-view="today" type="button">今日工作</button>
      <button data-view="customers" type="button">客户</button>
      <button data-view="deals" type="button">交易</button>
      <button data-view="actions" type="button">跟进任务</button>
      <button data-view="funnel" type="button">销售漏斗</button>
      <button data-view="activity" type="button">活动时间线</button>
    </nav>
    <button class="dealpilot-change" data-change-workspace type="button">切换工作区</button>`;
  attachDealPilotSidebar(panel, true);

  const board = document.createElement('section');
  board.className = 'dealpilot-board';
  board.hidden = true;
  board.innerHTML = `<header><strong data-board-title>今日工作</strong><div class="dealpilot-board-actions"><button data-board-refresh type="button" aria-label="刷新业务数据" title="刷新">↻</button><button data-board-close type="button" aria-label="关闭业务视图" title="关闭">×</button></div></header><div data-board-content>加载中...</div>`;
  document.body.append(board);

  // DSH re-creates pane contents while switching sessions. Keep the product
  // panel attached to the native conversation column when that happens.
  const conversationColumn = document.querySelector<HTMLElement>('[data-pane="conversation"], [class*="centerCol"]');
  if (conversationColumn && !conversationColumn.contains(board)) conversationColumn.append(board);

  const shade = document.createElement('div');
  shade.className = 'dealpilot-onboarding';
  shade.innerHTML = `<div class="dealpilot-onboarding-card"><div class="dealpilot-kicker">DealPilot</div><h1>选择一个工作区</h1><p>先绑定销售资料所在的工作区，之后对话和业务视图都会使用它。</p><label for="dealpilot-workspace-select">工作区</label><select id="dealpilot-workspace-select"><option value="">加载中...</option></select><div class="dealpilot-status" data-status>正在加载工作区...</div><div class="dealpilot-onboarding-actions"><button data-initialize hidden type="button">初始化并进入</button><button data-cancel-workspace hidden type="button">取消</button></div></div>`;
  document.body.append(shade);

  const style = document.createElement('style');
  style.textContent = `
    .dealpilot-route-panel{position:relative;z-index:1;width:auto;height:100%;min-height:0;padding:10px 8px;color:#20242a;font:14px/1.4 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;flex-direction:column;gap:10px;overflow:auto;background:transparent;border:0;box-shadow:none}
    .dealpilot-brand{display:flex;align-items:center;gap:10px}.dealpilot-mark{width:30px;height:30px;border-radius:6px;background:#17202b;color:#fff;display:grid;place-items:center;font-weight:700}.dealpilot-brand strong{display:block;font-size:15px}.dealpilot-brand small{display:block;color:#7b838e;font-size:11px;margin-top:2px}
    .dealpilot-current{border:1px solid #e1e5ea;border-radius:6px;padding:10px 11px;background:#fafbfc}.dealpilot-current span{display:block;color:#78808a;font-size:11px}.dealpilot-current strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;font-size:13px}
    .dealpilot-new,.dealpilot-change,.dealpilot-nav button{width:100%;border:0;border-radius:5px;text-align:left;cursor:pointer;font:inherit}.dealpilot-new{height:36px;padding:0 11px;background:#1769e0;color:#fff;font-weight:600}.dealpilot-new:disabled{opacity:.5;cursor:wait}.dealpilot-section-label{color:#8a929d;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-top:5px}.dealpilot-sessions{color:#7c848e;font-size:12px;padding:0 8px}.dealpilot-nav{display:flex;flex-direction:column;gap:2px;margin-top:2px}.dealpilot-nav button{background:transparent;padding:8px 10px;color:#4d5662}.dealpilot-nav button:hover,.dealpilot-nav button.active{background:#edf4ff;color:#1769e0;font-weight:600}.dealpilot-change{margin-top:auto;padding:8px 10px;background:#f5f6f8;color:#59616c;font-size:12px}
    .dealpilot-onboarding{position:fixed;z-index:2147482999;inset:0;background:rgba(246,248,250,.92);display:grid;place-items:center;padding:24px}.dealpilot-onboarding[hidden]{display:none}.dealpilot-onboarding-card{width:min(440px,100%);background:#fff;border:1px solid #dfe4ea;border-radius:8px;padding:28px;box-shadow:0 12px 40px rgba(18,28,45,.12)}.dealpilot-kicker{font-size:12px;color:#1769e0;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.dealpilot-onboarding h1{font-size:24px;margin:8px 0}.dealpilot-onboarding p{margin:0 0 20px;color:#68717c;font-size:13px}.dealpilot-onboarding label{display:block;font-size:12px;color:#5e6772;margin-bottom:6px}.dealpilot-onboarding select{width:100%;height:40px;border:1px solid #d6dce3;border-radius:5px;padding:0 10px;background:#fff;font:inherit}.dealpilot-status{min-height:34px;padding:10px 0;color:#69727d;font-size:12px}.dealpilot-status.error{color:#b42318}.dealpilot-onboarding-card button[data-initialize]{width:100%;height:38px;border:0;border-radius:5px;background:#1769e0;color:#fff;cursor:pointer;font-weight:600}.dealpilot-board{position:fixed;z-index:2147482998;right:0;top:0;bottom:0;width:min(680px,94vw);background:#fff;border-left:1px solid #e0e5eb;box-shadow:-8px 0 24px rgba(18,28,45,.1);overflow:auto}.dealpilot-board[hidden]{display:none}.dealpilot-board header{height:52px;padding:0 14px;border-bottom:1px solid #e8ebef;display:flex;align-items:center;justify-content:space-between}.dealpilot-board-actions{display:flex;gap:6px}.dealpilot-board header button{width:28px;height:28px;border:1px solid #d9dfe6;border-radius:5px;background:#fff;color:#59616c;cursor:pointer;font-size:18px}.dealpilot-board header button:hover{border-color:#1769e0;color:#1769e0}.dealpilot-board [data-board-content]{padding:14px}.dealpilot-board-toolbar{display:flex;gap:7px;margin-bottom:12px}.dealpilot-board-toolbar input,.dealpilot-board-toolbar select{height:34px;border:1px solid #d6dce3;border-radius:5px;padding:0 9px;background:#fff;color:#303741;font:12px inherit}.dealpilot-board-toolbar input{flex:1;min-width:0}.dealpilot-board-layout{display:grid;grid-template-columns:minmax(230px,1fr) minmax(230px,1fr);gap:12px;align-items:start}.dealpilot-board-list,.dealpilot-board-detail{min-width:0}.dealpilot-board-detail{border-left:1px solid #edf0f3;padding-left:12px;min-height:260px}.dealpilot-board-detail h3{margin:0 0 9px;font-size:16px;color:#20242a}.dealpilot-board-detail h4{margin:14px 0 6px;font-size:11px;color:#7a828d;text-transform:uppercase;letter-spacing:.04em}.dealpilot-board-detail p{margin:4px 0;color:#59616c;font-size:12px;line-height:1.55}.dealpilot-detail-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.dealpilot-detail-actions button{border:1px solid #d6dce3;border-radius:5px;background:#fff;color:#1769e0;padding:6px 8px;font:12px inherit;cursor:pointer}.dealpilot-detail-actions button:hover{background:#edf4ff}.dealpilot-board-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px}.dealpilot-board-metrics div{border:1px solid #e1e5ea;border-radius:5px;padding:8px}.dealpilot-board-metrics b{display:block;font-size:18px}.dealpilot-board-metrics span{font-size:10px;color:#7a828d}.dealpilot-board-item{display:block;width:100%;text-align:left;border:1px solid #e1e5ea;border-radius:5px;background:#fff;padding:10px;margin:0 0 7px;cursor:pointer}.dealpilot-board-item:hover,.dealpilot-board-item.selected{border-color:#1769e0;background:#f7faff}.dealpilot-board-item strong{display:block;font-size:13px}.dealpilot-board-item small{display:block;color:#737c87;margin-top:3px}.dealpilot-board-empty{padding:30px 8px;text-align:center;color:#7b838e;font-size:13px}.dealpilot-board-funnel{margin-bottom:8px}.dealpilot-board-funnel-row{display:grid;grid-template-columns:86px 1fr 28px;align-items:center;gap:7px;margin:7px 0;font-size:12px;color:#59616c}.dealpilot-board-funnel-bar{height:8px;background:#edf1f5;border-radius:4px;overflow:hidden}.dealpilot-board-funnel-bar i{display:block;height:100%;background:#1769e0;border-radius:4px}.dealpilot-route body:has(.dealpilot-board:not([hidden])){padding-right:min(680px,94vw)}.dealpilot-native-workspaces-hidden,.dealpilot-native-new-session-hidden{display:none!important}@media(max-width:900px){.dealpilot-board-layout{grid-template-columns:1fr}.dealpilot-board-detail{border-left:0;border-top:1px solid #edf0f3;padding:12px 0 0}.dealpilot-route body:has(.dealpilot-board:not([hidden])){padding-right:min(680px,94vw)}}@media(max-width:720px){.dealpilot-onboarding-card{padding:22px}}
  `;
  style.textContent += '.dealpilot-onboarding-actions{display:flex;gap:8px;margin-top:4px}.dealpilot-onboarding-actions button{flex:1;height:38px;border:0;border-radius:5px;cursor:pointer;font:inherit;font-weight:600}.dealpilot-onboarding-card button[data-cancel-workspace]{background:#f1f3f5;color:#59616c}.dealpilot-onboarding-card button[data-cancel-workspace]:hover{background:#e5e8ec}';
  document.head.append(style);

  const select = shade.querySelector<HTMLSelectElement>('#dealpilot-workspace-select')!;
  const status = shade.querySelector<HTMLElement>('[data-status]')!;
  const initializeButton = shade.querySelector<HTMLButtonElement>('[data-initialize]')!;
  const cancelButton = shade.querySelector<HTMLButtonElement>('[data-cancel-workspace]')!;
  let selectedId = '';
  let inspection: any;
  let workspaceBeforePicker = '';
  let inspectVersion = 0;

  const api = async (url: string, options?: RequestInit) => {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  };
  const setStatus = (text: string, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const setWorkspaceName = (name: string) => { panel.querySelector<HTMLElement>('[data-workspace-name]')!.textContent = name; };
  const boardTitles: Record<string, string> = { today: '今日工作', customers: '客户', deals: '交易', actions: '跟进任务', funnel: '销售漏斗', activity: '活动时间线' };
  let snapshot: any;
  let activeView = 'today';
  let selectedItem: any;
  let searchQuery = '';
  let filterValue = 'all';

  const actionRows = () => (snapshot?.deals || []).flatMap((deal: any) => (deal.actions || []).map((action: any) => ({
    ...action,
    deal_title: deal.title,
    customer_name: deal.customer_name,
  })));
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
    if (view === 'actions') return [item.customer_name, item.deal_title, item.status, item.due_at].filter(Boolean).join(' · ');
    if (view === 'today') return [item.customer_name, item.deal_title, item.bucket, item.due_at].filter(Boolean).join(' · ');
    if (view === 'funnel') return `数量 ${item.count ?? 0}`;
    return [item.occurred_at, item.channel, item.customer_ref || item.deal_ref].filter(Boolean).join(' · ');
  };
  const matchesFilter = (item: any, view: string) => {
    if (filterValue === 'all') return true;
    if (view === 'customers') return filterValue === 'priority' ? item.priority === 'high' : item.relationship_stage === filterValue;
    if (view === 'deals') return filterValue === 'risk' ? ['high', 'critical'].includes(item.risk_level) : filterValue === 'active' ? item.status === 'active' : item.funnel_stage === filterValue;
    if (view === 'actions') return filterValue === 'overdue' ? item.status !== 'completed' && item.due_at && Date.parse(item.due_at) < Date.now() : filterValue === 'open' ? item.status !== 'completed' && item.status !== 'cancelled' : item.status === filterValue;
    if (view === 'today') return filterValue === 'overdue' ? item.bucket === 'overdue' : filterValue === 'risk' ? item.bucket === 'risk' : item.bucket === filterValue;
    return true;
  };
  const filteredRows = (view: string) => sourceForView(view).filter((item) => {
    const haystack = `${itemTitle(item, view)} ${itemMeta(item, view)} ${item.risk_summary || item.reason || ''}`.toLowerCase();
    return (!searchQuery || haystack.includes(searchQuery.toLowerCase())) && matchesFilter(item, view);
  }).slice(0, 50);
  const filterOptions = (view: string) => {
    if (view === 'customers') return [['all', '全部'], ['priority', '高优先级'], ['new', '新客户'], ['qualified', '已筛选']];
    if (view === 'deals') return [['all', '全部'], ['active', '活跃交易'], ['risk', '高风险'], ...((snapshot?.funnel || []).map((x: any) => [x.stage, x.stage]))];
    if (view === 'actions') return [['all', '全部'], ['open', '未完成'], ['overdue', '已逾期'], ['planned', '待安排'], ['in_progress', '进行中'], ['completed', '已完成'], ['blocked', '已阻塞']];
    if (view === 'today') return [['all', '全部'], ['overdue', '逾期'], ['today', '今天'], ['risk', '风险'], ['confirmation', '待确认']];
    return [['all', '全部']];
  };
  const promptForItem = (item: any, view: string) => {
    const title = itemTitle(item, view);
    if (view === 'customers') return `请分析客户“${title}”的当前状态，并给出下一步销售建议。引用当前销售工作区的事实，不要猜测未知信息。`;
    if (view === 'deals') return `请分析交易“${title}”（客户：${item.customer_name || '未知'}），重点说明当前风险、漏斗阶段和下一步行动。`;
    if (view === 'actions' || view === 'today') return `请处理跟进任务“${title}”（${item.customer_name || ''} / ${item.deal_title || ''}）。先确认事实，再告诉我是否需要完成、延期或阻塞。`;
    return `请解释这条业务事件，并说明它对当前销售工作的影响：${title}。`;
  };
  const sendToConversation = (prompt: string) => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea:not([disabled]), textarea') || document.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!input) return;
    if (input instanceof HTMLTextAreaElement) input.value = prompt;
    else input.textContent = prompt;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    input.focus();
    board.querySelector<HTMLElement>('[data-board-feedback]')!.textContent = '已放入对话输入框，确认后发送。';
  };
  const renderDetail = (item: any, view: string) => {
    const detail = board.querySelector<HTMLElement>('[data-board-detail]');
    if (!detail) return;
    if (!item) { detail.innerHTML = '<div class="dealpilot-board-empty">选择一条记录查看详情</div>'; return; }
    const title = itemTitle(item, view);
    const details: string[] = [];
    if (view === 'customers') details.push(`<h4>客户概况</h4><p>关系阶段：${escapeHtml(item.relationship_stage || '未知')}<br>市场：${escapeHtml(item.market || '未知')}<br>ICP：${escapeHtml(item.icp_fit || '未知')}<br>优先级：${escapeHtml(item.priority || '未知')}</p>`);
    if (view === 'deals') details.push(`<h4>交易状态</h4><p>客户：${escapeHtml(item.customer_name || '未知')}<br>漏斗阶段：${escapeHtml(item.funnel_stage || '未知')}<br>风险：${escapeHtml(item.risk_level || '未知')}<br>${escapeHtml(item.risk_summary || '暂无风险说明')}</p>`);
    if (view === 'actions' || view === 'today') details.push(`<h4>跟进信息</h4><p>客户：${escapeHtml(item.customer_name || '未知')}<br>交易：${escapeHtml(item.deal_title || '未知')}<br>状态：${escapeHtml(item.status || item.bucket || '未知')}<br>到期：${escapeHtml(item.due_at || '未设置')}<br>${escapeHtml(item.reason || '')}</p>`);
    if (view === 'activity') details.push(`<h4>事件信息</h4><p>时间：${escapeHtml(item.occurred_at || '未知')}<br>渠道：${escapeHtml(item.channel || '未知')}<br>客户：${escapeHtml(item.customer_ref || '未关联')}<br>交易：${escapeHtml(item.deal_ref || '未关联')}</p>`);
    if (view === 'funnel') details.push(`<h4>阶段概览</h4><p>当前阶段包含 ${escapeHtml(item.count ?? 0)} 笔交易。</p>`);
    detail.innerHTML = `<h3>${escapeHtml(title)}</h3>${details.join('')}<div class="dealpilot-detail-actions"><button data-ask-agent type="button">在对话中分析</button>${view === 'actions' || view === 'today' ? '<button data-action-update type="button">请求处理</button>' : ''}</div>`;
    detail.querySelector('[data-ask-agent]')?.addEventListener('click', () => sendToConversation(promptForItem(item, view)));
    detail.querySelector('[data-action-update]')?.addEventListener('click', () => sendToConversation(promptForItem(item, view)));
  };
  const renderBoard = (view: string) => {
    activeView = view;
    const content = board.querySelector<HTMLElement>('[data-board-content]')!;
    board.querySelector<HTMLElement>('[data-board-title]')!.textContent = boardTitles[view] || '业务视图';
    if (!snapshot) { content.innerHTML = '<div class="dealpilot-board-empty">暂无业务数据</div>'; return; }
    const s = snapshot;
    const metrics = `<div class="dealpilot-board-metrics"><div><b>${s.summary.customers}</b><span>客户</span></div><div><b>${s.summary.active_deals}</b><span>活跃交易</span></div><div><b>${s.summary.today}</b><span>今日任务</span></div></div>`;
    const options = filterOptions(view).map(([value, label]) => `<option value="${escapeHtml(value)}"${value === filterValue ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
    const toolbar = `<div class="dealpilot-board-toolbar"><input data-board-search type="search" placeholder="搜索当前视图" value="${escapeHtml(searchQuery)}"><select data-board-filter>${options}</select></div><div class="dealpilot-board-layout"><div class="dealpilot-board-list" data-board-list></div><aside class="dealpilot-board-detail" data-board-detail></aside></div><div data-board-feedback class="dealpilot-board-feedback"></div>`;
    content.innerHTML = metrics + (view === 'funnel' ? `<div class="dealpilot-board-funnel">${(s.funnel || []).map((item: any) => `<div class="dealpilot-board-funnel-row"><span>${escapeHtml(item.stage)}</span><div class="dealpilot-board-funnel-bar"><i style="width:${Math.min(100, (Number(item.count || 0) / Math.max(1, ...((s.funnel || []).map((x: any) => Number(x.count || 0))))) * 100)}%"></i></div><b>${escapeHtml(item.count)}</b></div>`).join('')}</div>${toolbar}` : toolbar);
    const list = content.querySelector<HTMLElement>('[data-board-list]');
    if (list) {
      const rows = filteredRows(view);
      list.innerHTML = rows.length ? rows.map((item: any, index: number) => `<button class="dealpilot-board-item${selectedItem === item ? ' selected' : ''}" data-item-index="${index}" type="button"><strong>${escapeHtml(itemTitle(item, view))}</strong><small>${escapeHtml(itemMeta(item, view))}</small></button>`).join('') : '<div class="dealpilot-board-empty">没有匹配的数据</div>';
      list.querySelectorAll<HTMLButtonElement>('[data-item-index]').forEach((node) => node.addEventListener('click', () => { selectedItem = filteredRows(view)[Number(node.dataset.itemIndex)]; renderBoard(view); renderDetail(selectedItem, view); }));
    }
    content.querySelector<HTMLInputElement>('[data-board-search]')?.addEventListener('input', (event) => { searchQuery = (event.target as HTMLInputElement).value; renderBoard(view); renderDetail(selectedItem, view); });
    content.querySelector<HTMLSelectElement>('[data-board-filter]')?.addEventListener('change', (event) => { filterValue = (event.target as HTMLSelectElement).value; selectedItem = undefined; renderBoard(view); });
    renderDetail(selectedItem, view);
  };
  const showBoard = async (view: string) => {
    board.hidden = false; selectedItem = undefined; searchQuery = ''; filterValue = 'all'; renderBoard(view);
    if (!snapshot) {
      try { snapshot = await api(`/api/dealpilot/snapshot?workspaceId=${encodeURIComponent(selectedId)}`); renderBoard(view); }
      catch (err: any) { board.querySelector<HTMLElement>('[data-board-content]')!.innerHTML = `<div class="dealpilot-board-empty">${escapeHtml(err.message)}</div>`; }
    }
  };
  const getSessions = () => {
    try { return runtime?.get?.('sessions'); } catch { return undefined; }
  };
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
  const bindSession = async (workspaceId: string) => {
    let dshSessionId = '';
    try {
      dshSessionId = await createNativeSession(workspaceId);
    } catch (err) { console.warn('[dealpilot] native session binding unavailable', err); }
    const session = await api('/api/dealpilot/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, dshSessionId: dshSessionId || undefined }) });
    sessionStorage.setItem('dealpilot.sessionId', session.sessionId);
    sessionStorage.setItem('dealpilot.workspaceId', workspaceId);
    shade.hidden = true;
    cancelButton.hidden = true;
    setWorkspaceName(session.workspaceName || inspection?.name || workspaceId);
    panel.querySelector<HTMLElement>('[data-sessions]')!.textContent = '当前对话';
    document.body.classList.add('dealpilot-ready');
  };
  const restoreSession = async (workspaceId: string) => {
    const savedId = sessionStorage.getItem('dealpilot.sessionId');
    if (!savedId) return false;
    try {
      const session = await api(`/api/dealpilot/session/${encodeURIComponent(savedId)}`);
      if (session.workspaceId !== workspaceId || session.agentPreset !== 'dealpilot-sales') return false;
      const sessions = getSessions();
      if (sessions?.manager?.select) sessions.manager.select(savedId);
      shade.hidden = true;
      cancelButton.hidden = true;
      setWorkspaceName(session.workspaceName || inspection?.name || workspaceId);
      panel.querySelector<HTMLElement>('[data-sessions]')!.textContent = '当前对话';
      document.body.classList.add('dealpilot-ready');
      return true;
    } catch { return false; }
  };
  const inspect = async (id: string) => {
    const version = ++inspectVersion;
    selectedId = id;
    initializeButton.hidden = true;
    if (!id) { setStatus('请选择工作区'); return; }
    setStatus('正在检测...');
    try {
      inspection = await api('/api/dealpilot/workspaces/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: id }) });
      if (version !== inspectVersion) return;
      if (inspection.status === 'new') { setStatus('这是一个新的工作区，需要先初始化。'); initializeButton.hidden = false; return; }
      setStatus('已检测到现有销售资料，正在进入...');
      if (version !== inspectVersion) return;
      if (!(await restoreSession(id))) {
        if (version !== inspectVersion) return;
        await bindSession(id);
      }
    } catch (err: any) { setStatus(err.message, true); }
  };
  const load = async () => {
    try {
      const data = await api('/api/dealpilot/workspaces');
      select.innerHTML = '<option value="">选择工作区</option>' + (data.workspaces || []).map((w: any) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join('');
      const saved = sessionStorage.getItem('dealpilot.workspaceId');
      if (saved && (data.workspaces || []).some((w: any) => w.id === saved)) { select.value = saved; await inspect(saved); }
      else setStatus('请选择工作区');
    } catch (err: any) { setStatus(`工作区加载失败：${err.message}`, true); }
  };
  select.addEventListener('change', () => inspect(select.value));
  initializeButton.addEventListener('click', async () => {
    initializeButton.disabled = true; setStatus('初始化中...');
    try { await api('/api/dealpilot/workspaces/initialize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: selectedId }) }); await bindSession(selectedId); }
    catch (err: any) { setStatus(err.message, true); } finally { initializeButton.disabled = false; }
  });
  panel.querySelector('[data-change-workspace]')!.addEventListener('click', () => {
    workspaceBeforePicker = selectedId;
    cancelButton.hidden = false;
    shade.hidden = false;
    select.value = selectedId;
    setStatus('请选择工作区');
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
    const button = panel.querySelector<HTMLButtonElement>('[data-new-session]')!; button.disabled = true;
    try {
      const nativeId = await createNativeSession(selectedId);
      const created = await api('/api/dealpilot/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: selectedId, dshSessionId: nativeId }) });
      sessionStorage.setItem('dealpilot.sessionId', created.sessionId);
    } catch (err: any) { console.warn('[dealpilot] new conversation failed', err); } finally { button.disabled = false; }
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => {
    panel.querySelectorAll('[data-view]').forEach(item => item.classList.remove('active')); button.classList.add('active');
    void showBoard(button.dataset.view || 'today');
    window.dispatchEvent(new CustomEvent('dealpilot:view', { detail: { view: button.dataset.view, workspaceId: selectedId } }));
  }));
  board.querySelector('[data-board-refresh]')!.addEventListener('click', async () => {
    if (!selectedId) return;
    const refresh = board.querySelector<HTMLButtonElement>('[data-board-refresh]')!;
    refresh.disabled = true;
    try { snapshot = await api(`/api/dealpilot/snapshot?workspaceId=${encodeURIComponent(selectedId)}`); selectedItem = undefined; renderBoard(activeView); }
    catch (err: any) { board.querySelector<HTMLElement>('[data-board-feedback]')!.textContent = err.message; }
    finally { refresh.disabled = false; }
  });
  board.querySelector('[data-board-close]')!.addEventListener('click', () => { board.hidden = true; });
  const nativeObserver = new MutationObserver(() => {
    hideNativeWorkspaceControls();
    attachDealPilotSidebar(panel);
    const currentConversation = document.querySelector<HTMLElement>('[data-pane="conversation"], [class*="centerCol"]');
    if (currentConversation && !currentConversation.contains(board)) currentConversation.append(board);
  });
  nativeObserver.observe(document.body, { childList: true, subtree: true });
  load();
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
  if (ensureExpanded) {
    const expand = sidebar.querySelector<HTMLButtonElement>('button[aria-label="打开侧边栏"]');
    if (expand) expand.click();
  }
}

function hideNativeWorkspaceControls() {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [data-testid], [aria-label]'));
  for (const element of candidates) {
    if (element.textContent?.trim().match(/^(Workspace|工作区|Workspaces|工作空间)$/i) || element.getAttribute('aria-label')?.match(/workspace|工作区/i)) {
      const parent = element.closest('button, [role="button"], [data-testid]') || element;
      parent.classList.add('dealpilot-native-hidden');
    }
  }
  if (!document.querySelector('style[data-dealpilot-native-style]')) {
    const style = document.createElement('style');
    style.dataset.dealpilotNativeStyle = 'true';
    style.textContent = '.dealpilot-native-hidden{display:none!important}.dealpilot-route body:not(.dealpilot-ready) textarea,.dealpilot-route body:not(.dealpilot-ready) [contenteditable="true"]{pointer-events:none!important}';
    document.head.append(style);
  }
}

function escapeHtml(value: any): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[char]);
}
