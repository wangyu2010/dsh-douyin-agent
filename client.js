window.__ModuleLoader__.load({
  id: 'dsh-douyin-browser-local',
  factory: require => {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createElement: h, useEffect, useRef, useState } = React;
    const Button = primitives.Button, Input = primitives.Input || 'input';
    const PREFIX = '/api/douyin-browser';
    const routes = new Set(['/interactions/configure', '/state', '/diagnostics', '/diagnostics/repair', '/watch/schedule', '/watch/options', '/video/configure', '/video/start', '/video/stop', '/browser/open', '/persona/configure', '/model/configure', '/mode/configure', '/watch/start', '/watch/stop', '/spark/configure', '/spark/start', '/spark/stop', '/spark/resolve', '/comments/configure', '/comments/resolve', '/share/configure', '/share/resolve', '/chat/contacts', '/chat/configure', '/chat/start', '/chat/stop', '/chat/prepare', '/chat/resolve', '/chat/unanswered', '/chat/unanswered/resolve', '/media/configure', '/media/credentials', '/reports/generate']);
    const column = { display: 'flex', flexDirection: 'column', gap: 12 };
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
    const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: 0 };
    const formControl = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 9, maxWidth: '100%', width: '100%', boxSizing: 'border-box' };
    const videoPolicyKey = policy => policy && JSON.stringify([Array.isArray(policy.windows) ? [...new Set(policy.windows)] : null, policy.weekendWindows || null, policy.sessionMinutes]);
    // 设置页只保留发指令代替不了的三项。其余配置（时段、时长、主题、评论、点赞、收藏）一律由 AI 用 douyin_config 改。
    // 人格保留：它是身份核心，不应由 AI 静默改写。
    const fallbackCategories = { '基础设置': ['DSH 模型', '观看与评论', '人格与兴趣'], '观看日报': ['观看日报'], '自检与用量': ['自检与用量'] };

    const OPERATIONS = {
      '/bootstrap': '连接本机服务', '/state': '刷新运行状态', '/interactions/state': '读取好友在线状态', '/interactions/configure': '设置好友互动',
      '/browser/open': '打开抖音', '/watch/state': '读取自主观看状态', '/watch/schedule': '设置自动观看', '/watch/options': '保存观看主题', '/watch/start': '开始自主观看', '/watch/stop': '停止自主观看',
      '/video/status': '读取观看时段与用量', '/video/configure': '保存观看时段与额度', '/video/start': '开始观看', '/video/stop': '结束观看',
      '/chat/state': '读取自动回复状态', '/chat/contacts': '读取当前会话列表', '/chat/configure': '保存许可名单', '/chat/start': '启动自动回复', '/chat/stop': '停止自动回复', '/chat/prepare': '准备回复通道', '/chat/resolve': '解除会话暂停', '/chat/unanswered': '读取遗留待处理消息', '/chat/unanswered/resolve': '标记遗留待处理消息',
      '/share/state': '读取分享状态', '/share/configure': '设置自主分享', '/share/resolve': '核对分享结果', '/comments/state': '读取评论状态', '/comments/configure': '保存评论设置', '/comments/resolve': '核对评论结果',
      '/mode/state': '读取静默观看设置', '/mode/configure': '保存静默观看设置', '/media/state': '读取音频设置', '/media/configure': '保存音频设置', '/media/credentials': '保存音频密钥',
      '/persona': '读取人格', '/persona/card': '保存人格', '/persona/configure': '保存人格', '/model/configure': '保存模型设置', '/task/limits': '读取任务额度', '/task/limits/configure': '保存任务额度',
      '/task': '提交对话任务', '/stop': '停止对话任务', '/forward/contacts': '读取转发会话', '/forward': '转发作品', '/memory': '检索共享记忆',
      '/usage': '读取用量', '/diagnostics': '一键自检', '/diagnostics/repair': '修复自检问题', '/reports/generate': '生成观看日报', '/reports/read': '读取观看日报', '/reports/state': '读取日报目录',
    };

    function requestOperation(route, body) {
      const path = route.split('?')[0].replace(/^\/api/, '');
      if (path === '/task/limits' && body !== undefined) return '保存任务额度';
      if (path === '/watch/schedule' && typeof body?.enabled === 'boolean') return body.enabled ? '开始自主观看' : '暂停观看';
      return OPERATIONS[path] || '本机操作';
    }

    function requestFailure(failure, operation, { timeoutMs, write = false, signal } = {}) {
      failure = failure || new Error('操作未完成。');
      if (failure.operation) return failure;
      const timedOut = !Number.isInteger(failure.status) && (failure.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError' || /^(?:signal timed out|the operation was aborted due to timeout)\.?$/i.test(failure.message || ''));
      const cancelled = failure.name === 'AbortError';
      const transport = timedOut || cancelled || Boolean(timeoutMs && (failure instanceof TypeError || failure.name === 'TypeError'));
      const detail = timedOut ? `等待本机服务超时${timeoutMs ? `（${Math.round(timeoutMs / 1000)} 秒）` : ''}。` : cancelled ? '请求已取消。' : transport ? '未能连接本机服务。' : /^signal timed out\.?$/i.test(failure.message || '') ? `服务处理超时（${failure.message}）。` : failure.message || '操作未完成。';
      const error = new Error(`${operation}：${detail}${transport && write ? '请求结果尚未确认，请先刷新状态核对，勿重复提交。' : ''}`);
      error.operation = operation; error.requestError = transport; error.unconfirmed = transport && write;
      if (failure.status !== undefined) error.status = failure.status;
      if (failure.code !== undefined) error.code = failure.code;
      return error;
    }

    function operationLabel(name) {
      return ({ browserOpen:'打开抖音', browser:'打开抖音', refresh:'刷新连接', task:'提交对话任务', stop:'停止对话任务', settings:'保存模型设置', clearKey:'移除模型密钥', openMemory:'打开记忆文件夹', memory:'检索共享记忆', watchSchedule:'设置自动观看', schedule:'设置自动观看', interactions:'设置好友互动', chatList:'读取当前会话列表', chatPrepare:'准备回复通道', forwardList:'读取转发会话', forward:'转发作品', personaReload:'载入最新人格', diagnostics:'一键自检或修复', reportGenerate:'生成观看日报', reportRead:'读取观看日报' })[name] || (/^resolve-|^chatResolve:/.test(name) ? '解除会话暂停' : name.startsWith('key:') ? '保存音频密钥' : '本机操作');
    }

    function createSettingsTransport(globals = globalThis, rpc = globals.__DSH_TRANSPORT__?.rpc) {
      const carrier = globals.__DSH_TRANSPORT__;
      const address = globals.location;
      const http = address && ['http:', 'https:'].includes(address.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
      const desktop = ['dsh-app:', 'dsh:'].includes(address?.protocol) && address.hostname === 'app';
      const fetcher = typeof carrier?.fetch === 'function' ? carrier.fetch.bind(carrier) : (http || desktop) && typeof globals.fetch === 'function' ? globals.fetch.bind(globals) : null;
      let token = '';
      const writing = new Set();
      return {
        async request(route, input) {
          if (!routes.has(route) && !/^\/reports\/read\?date=\d{4}-\d{2}-\d{2}$/.test(route)) throw new Error('只允许本插件的原生设置接口。');
          if (!fetcher && typeof rpc?.call !== 'function') throw new Error('当前 DSH 页面没有可用的插件设置通信接口。请更新插件后完全退出并重开 DSH；若仍失败，请核对 DSH 版本与来源。可点击“刷新插件状态”重试。');
          if (input !== undefined && !token) throw new Error('请先刷新原生设置页，核实当前状态。');
          if (route === '/chat/unanswered' && !token) throw new Error('请先刷新原生设置页，核实当前状态。');
          const operation = requestOperation(route, input), write = input !== undefined, timeoutMs = route === '/state' ? 20_000 : 65_000;
          if (write && writing.has(route)) throw Object.assign(new Error(`${operation}正在处理，请等待当前请求完成。`), { operation, code: 'UI_OPERATION_BUSY' });
          if (write) writing.add(route);
          const signal = AbortSignal.timeout(timeoutMs);
          try {
          let response;
          if (!fetcher && typeof rpc?.call === 'function') {
            const reply = await rpc.call('/douyin-settings', 'request', { path: route, ...(input === undefined ? (route === '/chat/unanswered' ? { token } : {}) : { input, token }) }, signal);
            if (!reply?.ok) throw new Error(reply?.error?.message || 'DSH 设置通信失败，请确认插件后端已加载新版；操作不会自动重试。');
            const outcome = reply.value;
            if (!Number.isInteger(outcome?.status) || !outcome.body || typeof outcome.body !== 'object') throw new Error('DSH 设置接口版本不匹配，请完全退出后重开 DSH。');
            response = { status: outcome.status, ok: outcome.status >= 200 && outcome.status < 300, json: async () => outcome.body };
          } else response = await fetcher(PREFIX + route, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'content-type': 'application/json', ...(input !== undefined || route === '/chat/unanswered' ? { 'x-douyin-settings-token': token } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
          let value;
          try { value = await response.json(); }
          catch (failure) { if (signal.aborted || failure.name === 'TimeoutError') throw failure; const error = new Error(`插件设置接口未返回 JSON（HTTP ${response.status || '未知'}）。请检查插件后端是否启用、DSH 的 WebServer 服务及版本兼容性。`); error.status = response.status; throw error; }
          if (!response.ok) { const error = new Error(value.error || '原生设置操作未完成。'); error.status = response.status; throw error; }
          if (route === '/state') { if (typeof value.token !== 'string' || !value.token) throw new Error('原生设置未取得有效会话。'); token = value.token; const { token: hidden, ...state } = value; return state; }
          return value;
          } catch (failure) { throw requestFailure(failure, operation, { timeoutMs, write, signal }); }
          finally { if (write) writing.delete(route); }
        },
      };
    }

    function useAutosave({ value, initial, read, encode, write, canonical = (_result, payload) => payload, available = true }) {
      const [draft, setDraft] = useState(() => value ? read(value) : initial), [status, setStatus] = useState({});
      const current = useRef(draft), dirty = useRef(false), version = useRef(0), ack = useRef(null), timer = useRef(null), writing = useRef(false), queued = useRef(false), requested = useRef(false), alive = useRef(true), options = useRef(null);
      options.current = { read, encode, write, canonical, available };
      const schedule = immediate => { requested.current = true; clearTimeout(timer.current); timer.current = setTimeout(() => { void flush(); }, immediate ? 0 : 600); };
      async function flush() {
        requested.current = true; clearTimeout(timer.current); if (!alive.current || !dirty.current || !options.current.available) return;
        if (writing.current) { queued.current = true; return; }
        let payload; try { payload = options.current.encode(current.current); } catch (error) { setStatus({ kind: 'editing', message: error.message || '填写完整后自动生效。' }); return; }
        const submitted = version.current; writing.current = true; queued.current = false; requested.current = false; setStatus({ kind: 'saving', message: '正在保存…' });
        try { const result = await options.current.write(payload), expected = options.current.canonical(result, payload); if (alive.current && submitted === version.current) { ack.current = { version: submitted, key: JSON.stringify(expected) }; setStatus({ kind: 'saved', message: '已保存，等待状态同步。' }); } }
        catch (error) { if (alive.current) setStatus({ kind: 'error', message: `${error.message || '保存失败。'} 草稿已保留。` }); }
        finally { writing.current = false; if (alive.current && queued.current) schedule(true); }
      }
      function edit(patch, { immediate = false, blurOnly = false } = {}) {
        current.current = { ...current.current, ...patch }; version.current++; dirty.current = true; ack.current = null; setDraft(current.current); setStatus({ kind: 'editing', message: blurOnly ? '离开输入框后自动保存。' : '修改后自动保存。' }); clearTimeout(timer.current); requested.current = !blurOnly; if (blurOnly) queued.current = false; else schedule(immediate);
      }
      useEffect(() => {
        if (!value) return; let incoming, key; try { incoming = options.current.read(value); key = JSON.stringify(options.current.encode(incoming)); } catch { return; }
        if (ack.current?.version === version.current && ack.current.key === key) { dirty.current = false; ack.current = null; setStatus({ kind: 'saved', message: '已生效。' }); }
        if (!dirty.current && !writing.current) { current.current = incoming; setDraft(incoming); }
      }, [value]);
      useEffect(() => { if (available && requested.current && dirty.current) schedule(true); }, [available]);
      useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
      return { draft, edit, flush, status };
    }

    function SettingsPage({ rpc } = {}) {
      const [api] = useState(() => createSettingsTransport(globalThis, rpc));
      const [state, setState] = useState(null), [ready, setReady] = useState(false), [connectionError, setConnectionError] = useState(''), [notice, setNotice] = useState(''), [category, setCategory] = useState('基础设置');
      const [operationErrors, setOperationErrors] = useState({});
      const [busy, setBusy] = useState(new Set()), [diagnostics, setDiagnostics] = useState(null), [repairResult, setRepairResult] = useState(''), [report, setReport] = useState(null), [reportDate, setReportDate] = useState('');
      const [credentials, setCredentials] = useState({ mimo: '', minimax: '' }), [reviews, setReviews] = useState(new Set());
      const existingAuthorization = useRef(false); const alive = useRef(true), refreshing = useRef(null), refreshAgain = useRef(false), locks = useRef(new Set()), submitted = useRef(new Set()), keyValues = useRef(credentials);
      const active = value => value?.running || value?.starting || value?.busy || value?.worker?.alive;
      const operationActive = active(state?.watch) || state?.chat?.starting || state?.chat?.busy || state?.share?.busy;
      async function refresh(fresh = false) {
        if (refreshing.current) { if (fresh) refreshAgain.current = true; return refreshing.current; }
        const work = (async () => {
          let latest;
          do {
            refreshAgain.current = false;
            try { const value = await api.request('/state'); if (alive.current && !refreshAgain.current) { latest = value; setState(value); setReady(true); setConnectionError(''); } }
            catch (failure) { if (alive.current && !refreshAgain.current) { setReady(false); setConnectionError(failure.message); } }
          } while (alive.current && refreshAgain.current);
          return latest;
        })();
        refreshing.current = work; try { return await work; } finally { if (refreshing.current === work) refreshing.current = null; }
      }
      useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => { void refresh(); }, 2500); return () => { alive.current = false; clearInterval(timer); }; }, [api]);
      useEffect(() => { if (!reportDate && state?.reports?.date) setReportDate(state.reports.date); }, [state]);
      const write = route => async payload => { const result = await api.request(route, payload); void refresh(true); return result; };
      const list = text => String(text || '').split(/[\n,;，；]+/).map(item => item.trim()).filter(Boolean);
      const positive = (value, label) => { const number = Number(value); if (String(value).trim() === '' || !Number.isSafeInteger(number) || number < 1) throw new Error(`${label}请填写正整数。`); return number; };
      const model = useAutosave({ value: state?.model, initial: { provider: '', model: '' }, read: value => ({ provider: value.provider || '', model: value.model || '' }), encode: value => { if (!value.provider || !value.model) throw new Error('请选择提供商和模型。'); return value; }, write: write('/model/configure'), available: ready && !operationActive });
      const persona = useAutosave({ value: state?.persona, initial: { content: '', expectedRevision: null }, read: value => ({ content: value.manualText || '', expectedRevision: value.revision }), encode: value => value, write: write('/persona/configure'), canonical: (saved, payload) => saved?.revision ? { content: saved.manualText || '', expectedRevision: saved.revision } : payload, available: ready && !operationActive });
      // 观看时长/次数：空输入 = 不限（null），数字 = 限制；时段用逗号分隔的 "开始-结束"。
      const videoForm = useAutosave({
        value: state?.video?.policy, initial: { enabled: false, windows: '00:00-24:00', dailyMinutes: '', dailyRequests: '' },
        read: value => ({ enabled: value?.enabled === true, windows: Array.isArray(value?.windows) && value.windows.length ? value.windows.join(', ') : '00:00-24:00', dailyMinutes: value?.dailyMinutes == null ? '' : String(value.dailyMinutes), dailyRequests: value?.dailyRequests == null ? '' : String(value.dailyRequests) }),
        encode: value => {
          const windows = value.windows.split(/[,\n;，；]+/).map(item => item.trim()).filter(Boolean);
          if (!windows.length) throw new Error('请至少填写一个观看时段，例如 00:00-24:00。');
          const limit = (raw, label) => { const text = String(raw).trim(); if (!text) return null; const number = Number(text); if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}请填正整数，或留空表示不限。`); return number; };
          return { enabled: value.enabled, windows, dailyMinutes: limit(value.dailyMinutes, '每日观看分钟'), dailyRequests: limit(value.dailyRequests, '每日请求次数') };
        },
        write: write('/video/configure'), available: ready && !operationActive });
      const commentForm = useAutosave({
        value: state?.comments, initial: { enabled: true, dailyLimit: 50, perSessionLimit: 20 },
        read: value => ({ enabled: value?.enabled === true, dailyLimit: String(value?.dailyLimit ?? 50), perSessionLimit: String(value?.perSessionLimit ?? 20) }),
        encode: value => ({ enabled: value.enabled, dailyLimit: positive(value.dailyLimit, '每日评论次数'), perSessionLimit: positive(value.perSessionLimit, '每次观看评论次数') }),
        write: write('/comments/configure'), available: ready && !operationActive });
      async function perform(key, action) {
        if (!ready || locks.current.has(key)) return; locks.current.add(key); setBusy(new Set(locks.current)); setNotice('');
        setOperationErrors(old => { const next = { ...old }; delete next[key]; return next; });
        try { const value = await action(); if (alive.current) setNotice(`${operationLabel(key)}已完成。`); await refresh(true); return value; }
        catch (failure) { if (alive.current) { const detail = requestFailure(failure, operationLabel(key)); setOperationErrors(old => ({ ...old, [key]: { message: detail.message, requestError: detail.requestError === true, unconfirmed: detail.unconfirmed === true } })); } await refresh(true); }
        finally { locks.current.delete(key); if (alive.current) setBusy(new Set(locks.current)); }
      }
      const button = (label, key, action, disabled = false, needsReady = true) => h(Button, { type: 'button', size: 'sm', variant: 'outline', disabled: (needsReady && !ready) || busy.has(key) || disabled, onClick: action }, busy.has(key) ? '处理中…' : label);
      const note = text => text ? h('p', { style: muted }, text) : null;
      const status = form => form.status.message && h('p', { role: form.status.kind === 'error' ? 'alert' : 'status', style: muted }, form.status.message);
      const section = (title, ...children) => h('section', { role: 'tabpanel', 'aria-label': title, style: { ...column, marginBottom: 24 } }, h('h3', null, title), ...children);
      const field = (label, form, key, extra = {}) => h('label', { style: column }, h('span', null, label), h(Input, { 'aria-label': label, value: form.draft[key], disabled: !ready, onChange: event => form.edit({ [key]: event.target.value }), ...extra }));
      const area = (label, form, key, rows = 2, blurOnly = false, disabled = false) => h('label', { style: column }, label, h('textarea', { 'aria-label': label, rows, value: form.draft[key], disabled: !ready || disabled, style: formControl, onChange: event => form.edit({ [key]: event.target.value }, { blurOnly }), onBlur: blurOnly ? () => { void form.flush(); } : undefined }));
      const toggle = (label, checked, onChange, disabled = false) => h('label', { style: row }, h('input', { type: 'checkbox', 'aria-label': label, checked: checked === true, disabled: !ready || disabled, onChange: event => onChange(event.target.checked) }), label);
      const select = (label, value, options, onChange, disabled = false) => h('label', { style: column }, label, h('select', { 'aria-label': label, value, style: formControl, disabled: !ready || disabled, onChange: event => onChange(event.target.value) }, ...options.map(([key, text]) => h('option', { key, value: key }, text))));
      const reviewList = kind => (state?.[kind]?.needsReview || []).map(item => { const key = `${kind}:${item.operationId}`; return h('div', { key, style: column }, note(`待核对：${item.videoId ? `作品 ${item.videoId}` : '消息'} · ${item.status || ''}`), submitted.current.has(key) ? note('核对结果已提交，等待回读。') : h('div', { style: row }, ...[['confirmed', '已核对发送成功'], ['not-sent', '已核对未发送']].map(([outcome, label]) => button(label, key, () => { submitted.current.add(key); setReviews(new Set(submitted.current)); void perform(key, async () => { try { return await api.request(`/${kind}/resolve`, { operationId: item.operationId, outcome }); } catch (error) { submitted.current.delete(key); setReviews(new Set(submitted.current)); throw error; } }); }, state?.[kind]?.busy)))); });
      const shareFailureMessage = item => typeof item?.failure?.message === 'string' && item.failure.message.trim() ? item.failure.message : item?.status === 'not-sent' ? '旧记录没有保存详细失败原因。' : '';
      const presence = ready ? state?.interactions?.presence : null, replyPresence = presence?.reply || presence, watchState = presence?.watch, presenceLabel = replyPresence?.label || '状态待核实', presenceReason = replyPresence?.reason || '正在读取好友回复服务状态。', watchLabel = watchState?.active ? watchState.label : '';
      return h('div', { style: { ...column, maxWidth: 900, paddingBottom: 32 } },
        h('h2', null, '大肥鱼抖音助手'), !ready && h('p', { role: 'status' }, '正在核实插件状态。'), connectionError && h('p', { role: 'alert' }, connectionError),
        ...Object.entries(operationErrors).map(([key, failure]) => h('div', { key, role: 'alert', style: row }, h('span', null, `${failure.requestError ? '上次操作：' : ''}${failure.message}${failure.requestError && ready ? failure.unconfirmed ? ' 本机服务当前已连接；请核对上述操作是否生效。' : ' 本机服务当前已连接。' : ''}`), h('button', { type: 'button', 'aria-label': `清除${operationLabel(key)}提示`, onClick: () => setOperationErrors(old => { const next = { ...old }; delete next[key]; return next; }) }, '×'))), notice && h('p', { role: 'status' }, notice),
        h('div', { role: 'status', 'aria-live': 'polite', style: { ...row, position: 'sticky', top: 0, zIndex: 5, background: 'var(--dsw-alias-bg-base, #fff)', padding: '8px 0' }, title: [presenceReason, watchState?.active ? watchState.reason : ''].filter(Boolean).join(' ') }, h('span', { 'aria-label': '好友互动状态', title: presenceReason, style: { border: '1px solid currentColor', borderRadius: 20, padding: '6px 12px', whiteSpace: 'nowrap' } }, `${replyPresence?.online === true ? '●' : '○'} ${presenceLabel}`), watchState?.active && h('small', { role: 'status', 'aria-label': '自主观看状态', title: watchState.reason, style: muted }, `◉ ${watchLabel}`), (['attention', 'preparing'].includes(replyPresence?.status) || watchState?.active && replyPresence?.online !== true) && h('small', { role: replyPresence?.status === 'attention' ? 'alert' : 'status', style: muted }, presenceReason)),
        h('div', { style: row }, button('刷新插件状态', 'refresh', () => { void refresh(); }, false, false), button('打开抖音', 'browser', () => { void perform('browser', () => api.request('/browser/open', {})); })),
        h('div', { role: 'tablist', 'aria-label': '抖音设置分类', style: row }, ...Object.keys(fallbackCategories).map(name => h(Button, { key: name, role: 'tab', type: 'button', size: 'sm', variant: category === name ? 'primary' : 'outline', 'aria-selected': category === name, onClick: () => setCategory(name) }, name))),
        category === '基础设置' && h('div', null,
          section('DSH 模型', select('模型提供商', model.draft.provider, [['', '请选择 DSH 提供商'], ...(state?.model?.providers || []).map(item => [item.id, item.name || item.id])], provider => model.edit({ provider, model: '' }, { immediate: true }), operationActive), select('模型名称', model.draft.model, [['', '请选择模型'], ...(state?.model?.models || []).filter(item => item.provider === model.draft.provider).map(item => [item.id, item.name || item.id])], value => model.edit({ model: value }, { immediate: true }), operationActive), status(model), note(state?.model?.configured ? '模型已配置。' : '请选择已配置的 DSH 模型。')),
          section('观看与评论',
            toggle('允许观看视频', videoForm.draft.enabled, value => videoForm.edit({ enabled: value }, { immediate: true }), operationActive),
            field('观看时段（逗号分隔，如 00:00-24:00）', videoForm, 'windows', { blurOnly: true, onBlur: () => { void videoForm.flush(); } }),
            field('每日观看时长（分钟，留空不限）', videoForm, 'dailyMinutes', { blurOnly: true, onBlur: () => { void videoForm.flush(); } }),
            field('每日模型请求次数（留空不限）', videoForm, 'dailyRequests', { blurOnly: true, onBlur: () => { void videoForm.flush(); } }),
            status(videoForm), note(`今日已看 ${Math.round((state?.video?.daily?.usedSeconds || 0) / 60)} 分钟 · 模型请求 ${state?.video?.daily?.requests || 0} 次`),
            toggle('允许发表公开评论', commentForm.draft.enabled, value => commentForm.edit({ enabled: value }, { immediate: true }), operationActive),
            field('每日评论次数上限（1-50）', commentForm, 'dailyLimit', { blurOnly: true, onBlur: () => { void commentForm.flush(); } }),
            field('每次观看评论次数上限（1-20）', commentForm, 'perSessionLimit', { blurOnly: true, onBlur: () => { void commentForm.flush(); } }),
            status(commentForm), note('修改后自动保存；评论开关在有待核对记录时会拒绝保存。')),
          section('人格与兴趣', area('大肥鱼人格正文', persona, 'content', 14, true, operationActive), status(persona), persona.status.kind === 'error' && button('载入最新人格（替换草稿）', 'personaReload', () => { void perform('personaReload', async () => { const latest = await refresh(true); if (!latest?.persona?.revision) throw new Error('未读到最新人格，原草稿已保留。'); persona.edit({ content: latest.persona.manualText || '', expectedRevision: latest.persona.revision }, { blurOnly: true }); return latest.persona; }); }), note('离开输入框后保存。插件与软件共用人格，未保存草稿不会被轮询覆盖。'), note(state?.persona?.personaFolder))),
        category === '观看日报' && section('观看日报', note(state?.reports?.folder), button('生成今天日报', 'reportGenerate', () => { void perform('reportGenerate', async () => { const value = await api.request('/reports/generate', {}); setReport(value); return value; }); }), h('label', { style: column }, '日报日期', h('input', { type: 'date', 'aria-label': '日报日期', style: formControl, value: reportDate, onChange: event => setReportDate(event.target.value) })), button('读取所选日报', 'reportRead', () => { void perform('reportRead', async () => { if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error('请选择有效日期。'); const value = await api.request(`/reports/read?date=${reportDate}`); setReport(value); return value; }); }), report && h('pre', { 'aria-label': '日报内容', style: { whiteSpace: 'pre-wrap' } }, report.markdown || '暂无内容')),
        category === '自检与用量' && section('自检与用量', button('一键自检', 'diagnostics', () => { void perform('diagnostics', async () => { const value = await api.request('/diagnostics', {}); setDiagnostics(value); setRepairResult(''); return value; }); }), diagnostics && h('div', { style: column }, ...(diagnostics.checks || []).map(item => h('div', { key: item.id }, note(`${({ pass: '通过', warning: '待核对', fail: '未通过' })[item.status]} · ${item.label}：${item.message} [${item.code || ''}]`), ...(item.resolution?.steps || []).map(step => note(step)))), ...(diagnostics.repairableActions || []).map(action => button(`修复：${action.label}`, 'diagnostics', () => { void perform('diagnostics', async () => { const value = await api.request('/diagnostics/repair', { reportId: diagnostics.reportId, action: action.id }); setDiagnostics(value.after); setRepairResult(value.message); return value; }); })), note(repairResult), h('details', null, h('summary', null, '查看或复制诊断报告'), h('textarea', { 'aria-label': '诊断报告', readOnly: true, rows: 12, style: formControl, value: JSON.stringify(diagnostics, null, 2) }))), h('h3', null, '今日用量'), note(`模型响应 ${state?.usage?.today?.requests || 0} 次 · 已报告 ${state?.usage?.today?.totalTokens || 0} Token`), note(`输入 ${state?.usage?.today?.promptTokens || 0} · 输出 ${state?.usage?.today?.completionTokens || 0} · 缓存命中 ${state?.usage?.today?.cacheReportedRequests ? state.usage.today.cachedTokens : '未报告'} · 用量未知 ${state?.usage?.today?.unknownRequests || 0} 次`), state?.usage?.inFlight > 0 && note(`请求中 ${state.usage.inFlight} 次，Token 等模型返回后记录。`), ...(state?.usage?.groups || []).map(item => note(`${item.model} · ${item.requests} 次响应 · ${item.totalTokens} Token`)), note(state?.usage?.note))
      );
    }

    function apply(ctx) {
      let rpc;
      try { rpc = (ctx.get?.('connection') || ctx.connection)?.rpc; } catch {}
      const Page = rpc ? () => h(SettingsPage, { rpc }) : SettingsPage;
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'douyin-browser', order: 16, label: () => '刷抖音' }, Page));
    }
    return { name: 'douyin-browser-settings', inject: ['slots', 'connection'], apply, SettingsPage, createSettingsTransport };
  },
});
