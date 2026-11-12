import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as waitForCommentTick } from 'node:timers/promises';
import { BrowserController, readPageState } from './core.mjs?v=9';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { prepareCommentText } from './comment-text.mjs';
import { humanClick, ensureEditorText, clearEditor, normalizeDraft, createRandom } from './human-input.mjs';
import { writeJson } from './atomic-write.mjs';

// 评论发布器（最小可用版）。
// 2026-11-11 在已登录专用 Edge 上实测通过真实发布，据此重写：
//   评论区默认折叠 → 点 [data-e2e="feed-comment-icon"] 展开
//   输入区 .comment-input-inner-container → 点击后才生成 public-DraftEditor-content
//   发布按钮 = .commentInput-right-ct 内 span.oXIqR6qH（图标 fill #FE2C55）
//   成功判据 = 评论列表条数 +1 且输入框被清空
// 旧版堆砌的几何见证、事件见证、SVG 路径签名、React fiber 身份爬取均已删除。

const stop = signal => signal?.throwIfAborted();
const cleanDraft = value => String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
// 判断输入框里的残留是不是我们自己抽的模板句。
// 发布流程中途失败时（例如许可被拒、点击超时），文本已经打进输入框但没写收据，
// 下次就认不出来，会被当成「用户草稿」永久挡住。这里用模板池兜底识别。
let corePoolCache = null;
async function corePool() {
  if (corePoolCache) return corePoolCache;
  try {
    const { CORE_TEMPLATES } = await import('./interaction-gate.mjs');
    corePoolCache = CORE_TEMPLATES.map(item => String(item).replace(/[。！!]+$/u, '')).filter(Boolean);
  } catch { corePoolCache = []; }
  return corePoolCache;
}
// 只要句子里「包含」某个模板主句，就认定是我们自己发的。
// 前后缀只是贴在主句外面，包含主句就足够判定，不需要把前缀后缀也导进来。
// 另外：前后缀本身也能拼出句子（如「说真的，…，学到了」），
// 所以再补一条：句子里同时出现两个以上我们的常用词，也算自己的残留。
const OUR_MARKERS = ['学到了', '支持一下', '继续加油', '收藏了', '期待更多', '看完觉得', '不得不说', '讲真', '说真的', '整体上', '挺有', '不错', '在理', '舒服', '到位', '扎实', '实用', '有收获', '讲得'];
async function looksLikeOurTemplate(value) {
  const text = cleanDraft(value);
  if (!text || text.length > 200) return false;
  // 模板句都是通用赞美，出现链接、@、长数字的一律当作别人的东西，不动。
  if (/https?:\/\/|@|\.com|\d{5,}/.test(text)) return false;
  const pool = await corePool();
  if (pool.some(core => core.length >= 4 && text.includes(core))) return true;
  const hits = OUR_MARKERS.filter(word => text.includes(word)).length;
  return hits >= 2;
}
const SEND_BUTTON_CLASS = 'oXIqR6qH';
const COMMENT_ICON = '[data-e2e="feed-comment-icon"]';
const INPUT_AREA = '.comment-input-inner-container';
const EDITOR = '.public-DraftEditor-content, [contenteditable="true"]';
const PRIVATE = '[data-e2e="im-dialog"],[data-e2e="danmaku-container"],[data-e2e="conversation-item"]';

const fail = (message, extra) => Object.assign(new Error(message), extra || {});

function assertVideo(state, expectedVideoId) {
  if (state?.loginRequired || state?.verificationRequired || state?.blocked || state?.privateChatVisible || state?.unsupportedPage) {
    throw fail('抖音页面需要手动处理（登录或验证），未发布评论。', { needsUserAction: true });
  }
  if (state?.video?.id !== expectedVideoId) throw fail('当前作品与预期不一致，未发布评论。');
  const url = state.video.url || state.url;
  if (url) {
    let current; try { current = new URL(url); } catch { current = null; }
    if (!current || current.origin !== 'https://www.douyin.com') throw fail('当前页面已离开抖音，未发布评论。');
  }
}

// 读当前登录账号身份。video-forward.mjs 也在用，保留原实现（它工作正常）。
export function readCommentSelfIdentity() {
  const denied = reasonCode => ({ ready: false, ownProfileId: null, reasonCode });
  if (location.origin !== 'https://www.douyin.com') return denied('self-origin-unavailable');
  const privateArea = '[data-e2e="im-dialog"],[data-e2e="conversation-item"],[data-e2e="comment-item"]';
  const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden')) return false; for (let node = element; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) === 0) return false; return true; };
  const anchors = [...document.querySelectorAll('.tab-user_self a[href]')].filter(anchor => visible(anchor) && !anchor.closest(privateArea));
  if (anchors.length !== 1) return denied('self-navigation-ambiguous');
  let route;
  try { route = new URL(anchors[0].getAttribute('href'), location.origin); } catch { return denied('self-navigation-invalid'); }
  if (route.origin !== location.origin || route.username || route.password) return denied('self-navigation-invalid');
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{5,300}$/.test(value) && value !== 'self';
  const secureId = /^\/user\/([A-Za-z0-9_-]{5,300})\/?$/.exec(route.pathname)?.[1] || null;
  if (!secureId && !/^\/user\/self\/?$/.test(route.pathname)) return denied('self-navigation-invalid');
  let accessor = false, conflict = false, loggedOut = false;
  const data = (object, key) => {
    if (!object || typeof object !== 'object') return undefined;
    let descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) { const prototype = Object.getPrototypeOf(object); if (prototype) descriptor = Object.getOwnPropertyDescriptor(prototype, key); }
    if (!descriptor) return undefined;
    if (!('value' in descriptor)) { accessor = true; return undefined; }
    return descriptor.value;
  };
  const ids = new Set(), seen = new Set();
  for (const node of new Set([anchors[0], anchors[0].closest('.tab-user_self')])) {
    if (!node) continue;
    const keys = Object.getOwnPropertyNames(node).filter(key => key.startsWith('__reactFiber$'));
    if (keys.length > 1) { conflict = true; continue; }
    let fiber = keys.length === 1 ? data(node, keys[0]) : null;
    for (let depth = 0; fiber && depth <= 5; depth++) {
      if (depth > 0) fiber = data(fiber, 'return');
      if (!fiber) break;
      const props = data(fiber, 'memoizedProps'), user = data(props, 'userInfo');
      if (!user || typeof user !== 'object' || seen.has(user)) continue;
      seen.add(user);
      const isLogin = data(user, 'isLogin'), status = data(user, 'statusCode');
      if (isLogin === false || typeof status === 'number' && status !== 0) { loggedOut = true; continue; }
      if (isLogin !== true || status !== 0) continue;
      const info = data(user, 'info'); if (!info || typeof info !== 'object') continue;
      const camel = data(info, 'secUid'), snake = data(info, 'sec_uid');
      if (camel !== undefined && !validId(camel) || snake !== undefined && !validId(snake) || camel !== undefined && snake !== undefined && camel !== snake) { conflict = true; continue; }
      if (validId(camel)) ids.add(camel); if (validId(snake)) ids.add(snake);
    }
  }
  if (accessor) return denied('self-metadata-accessor');
  if (loggedOut) return denied('self-not-logged-in');
  if (conflict || ids.size > 1 || secureId && ids.size === 1 && !ids.has(secureId)) return denied('self-identity-conflict');
  const ownProfileId = secureId || [...ids][0];
  if (!validId(ownProfileId)) return denied('self-identity-unavailable');
  return { ready: true, ownProfileId, source: secureId ? ids.size ? 'navigation-and-login-metadata' : 'secure-navigation' : 'navigation-login-metadata' };
}

export class CommentBrowser {
  constructor({ source = 'api', controller, videoLimits, stateDir = resolveRuntimePaths().stateDir, random } = {}) {
    if (!['api', 'dsh'].includes(source)) throw new TypeError('评论入口只能是 api 或 dsh。');
    Object.assign(this, { source, stateDir });
    this.videoLimits = videoLimits ?? new VideoLimits({ stateDir });
    this.controller = controller ?? new BrowserController({ source, videoLimits: this.videoLimits });
    this.ownsController = !controller;
    this.random = random ?? createRandom();
    this.receiptsFile = path.join(stateDir, 'comment-browser-receipts.json');
    this.guardFile = path.join(stateDir, 'comment-post.guard');
  }

  // 收据只保留最小信息：作品、状态、评论文本，用来防同一作品重复发。
  receipts() {
    try {
      const value = JSON.parse(fs.readFileSync(this.receiptsFile, 'utf8'));
      if (!value || value.version !== 1 || !Array.isArray(value.operations)) throw new Error();
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, operations: [] };
      return { version: 1, operations: [] };
    }
  }
  record(operation) {
    const value = this.receipts();
    const index = value.operations.findIndex(item => item.operationId === operation.operationId);
    if (index < 0) value.operations.push(operation); else value.operations[index] = operation;
    fs.mkdirSync(this.stateDir, { recursive: true });
    // 原子写统一走公共模块：这份回执之前也自带一份 rename 实现，Windows 上会 EPERM。
    writeJson(this.receiptsFile, value);
  }
  acquire() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    let descriptor;
    try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('另一个评论正在进行，或上次发布锁需要核对。'); throw error; }
    const owner = { pid: process.pid, token: randomUUID() };
    try { fs.writeFileSync(descriptor, JSON.stringify(owner)); } finally { fs.closeSync(descriptor); }
    return () => { try { const current = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.guardFile); } catch { /* 锁已被别处清理。 */ } };
  }
  async gate(signal) { stop(signal); const state = this.videoLimits.state(); if (!state.allowed) throw new Error(state.reason || '有限观看时段已结束，未发布评论。'); }

  // 抖音网页会悬浮若干透明的全屏手势/交互层（slideList 的 fullscreen_capture_feedback、
  // immersive 的 positionBox 等），间歇性拦截真实鼠标事件——按钮看得见、字打得进，
  // 但 page.mouse 的点击全被这些层吃掉，发送永远不生效。
  // 修法：点击前按坐标检查 elementFromPoint，把挡在目标前面的悬浮层 pointer-events:none（可逆的 style，不动结构）。
  async clearPointerBlockers(page, point, signal) {
    if (!point) return;
    await page.evaluate(({ x, y }) => {
      for (let depth = 0; depth < 6; depth++) {
        const top = document.elementFromPoint(x, y);
        if (!top) return;
        const hit = top.closest('.commentInput-right-ct, [class*="commentInput-right"], .comment-input-inner-container, .public-DraftEditor-content, [contenteditable="true"]');
        if (hit) return; // 已经点到我们的目标区域，无需再清。
        top.style.pointerEvents = 'none'; // 悬浮层让路，继续探测下一层。
      }
    }, { x: point.x, y: point.y }).catch(() => {});
    if (signal) stop(signal);
  }

  // 展开评论区：默认是折叠的，必须点评论图标。
  async openPanel(page, signal) {
    const opened = () => page.evaluate(sel => {
      const visible = el => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return b.width >= 120 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      return [...document.querySelectorAll(sel)].some(visible);
    }, INPUT_AREA);
    if (await opened()) return true;
    // 推荐流是轮播，DOM 里同时存在相邻几条的评论图标，只有一条在当前视口内。
    // 用 .first() 会点到视口外那个，点击无效且永远打不开评论区。
    const point = await page.evaluate(sel => {
      const nodes = [...document.querySelectorAll(sel)];
      for (let i = 0; i < nodes.length; i++) {
        const r = nodes[i].getBoundingClientRect(), s = getComputedStyle(nodes[i]);
        if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') continue;
        if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    }, COMMENT_ICON);
    if (!point) return false;
    // 真实鼠标移动 + 点击：force 点击会绕过命中检测，页面收不到事件。
    await page.mouse.move(point.x, point.y, { steps: 8 + Math.floor(Math.random() * 6) });
    await page.waitForTimeout(100 + Math.floor(Math.random() * 150));
    await page.mouse.click(point.x, point.y, { delay: 40 + Math.floor(Math.random() * 60) });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      stop(signal);
      if (await opened()) return true;
      await waitForCommentTick(150, undefined, { signal });
    }
    return false;
  }

  // 点开输入区，等 DraftEditor 生成。只认真正可见且有尺寸的那个编辑器。
  async activateEditor(page, signal) {
    const area = page.locator(INPUT_AREA).filter({ visible: true }).first();
    if (await area.count() === 0) return null;
    const areaBox = await area.boundingBox().catch(() => null);
    await this.clearPointerBlockers(page, areaBox ? { x: areaBox.x + areaBox.width / 2, y: areaBox.y + areaBox.height / 2 } : null, signal);
    await area.click({ timeout: 5000 }).catch(() => {});
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      stop(signal);
      // 页面上可能有多个 DraftEditor（隐藏的、私信里的），必须按真实尺寸过滤。
      const index = await page.evaluate(sel => {
        const list = [...document.querySelectorAll(sel)].filter(el => {
          const r = el.getBoundingClientRect(), s = getComputedStyle(el);
          return r.width > 40 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden';
        });
        if (!list.length) return -1;
        const all = [...document.querySelectorAll(sel)];
        return all.indexOf(list[0]);
      }, EDITOR).catch(() => -1);
      if (index >= 0) { await page.waitForTimeout(120); return page.locator(EDITOR).nth(index); }
      await waitForCommentTick(120, undefined, { signal });
    }
    return null;
  }

  // 发布按钮：工具栏内红色（#FE2C55）且不透明的发送箭头 span。
  // 抖音会改混淆 class（oXIqR6qH → wchsYBpK jfGCpJo0），但 svg 红色+opacity=1 这个特征稳定。
  // 它是输入文字之后才出现的，所以要一直等到超时，不能只等一下。
  async findSend(page, signal, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    do {
      stop(signal);
      const count = await page.evaluate(sel => {
        const toolbar = document.querySelector('.commentInput-right-ct, [class*="commentInput-right"]');
        if (!toolbar) return 0;
        return [...toolbar.querySelectorAll('span')].filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width <= 12 || r.height <= 12) return false;
          const path = el.querySelector('svg path');
          if (!path) return false;
          if ((path.getAttribute('fill') || '').toUpperCase() !== '#FE2C55') return false;
          return Number(getComputedStyle(el).opacity) > 0.9;
        }).length;
      }, SEND_BUTTON_CLASS).catch(() => 0);
      if (count >= 1) return page.locator('.commentInput-right-ct span, [class*="commentInput-right"] span').filter({
        visible: true,
        has: page.locator('svg path[fill="#FE2C55"], svg path[fill="#fe2c55"]'),
      }).first();
      await waitForCommentTick(250, undefined, { signal });
    } while (Date.now() < deadline);
    return null;
  }

  // 评论快照：条数 + 首条文本。抖音刚发出的评论会显示相对时间「刚刚」，是最可靠的新增信号。
  snapshotComments(page) {
    return page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-e2e="comment-item"]')].filter(el => el.getBoundingClientRect().height > 0);
      const first = items[0] ? (items[0].innerText || '').replace(/\n+/g, ' ') : '';
      return { count: items.length, firstIsJustNow: /刚刚/.test(first), firstText: first.slice(0, 80) };
    });
  }

  async post({ expectedVideoId, text, ...extra } = {}, { signal: parentSignal, authorize, autonomousRunId } = {}) {
    if (typeof expectedVideoId !== 'string' || !/^\d{1,64}$/.test(expectedVideoId) || Object.keys(extra).length) throw new TypeError('评论只能指定当前作品编号与纯文字。');
    text = prepareCommentText(text);
    if (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function') {
      return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论缺少本机许可，未发布。' };
    }
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (await authorize({ phase, videoId: expectedVideoId }) !== true) throw new Error('评论许可已撤回，未继续发布。'); stop(signal); };
    await authorized('prepare'); await this.gate(signal);

    const release = this.acquire();
    const operation = { operationId: randomUUID(), videoId: expectedVideoId, text, startedAt: new Date().toISOString(), status: 'clicking' };
    let clicked = false;
    try {
      if (this.receipts().operations.some(item => item.videoId === expectedVideoId && ['clicking', 'confirmed'].includes(item.status))) {
        throw new Error('同一作品已发布或正在发布评论，未再次点击。');
      }
      return await this.controller.withPage(async page => {
        const state = await page.evaluate(readPageState);
        assertVideo(state, expectedVideoId);
        if (!await this.openPanel(page, signal)) {
          return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '评论区没有展开，未发布。' };
        }
        const editor = await this.activateEditor(page, signal);
        if (!editor) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '没有找到评论输入框，未发布。' };

        // 输入框里已有内容时判断它的来历：
        //   已发出评论的残留（抖音发布后不清空输入框）→ 可以清掉重写
        //   我们的收据里记过的旧文本 → 同样可以清掉
        //   模板池里的句子 → 是我们自己抽的，发布中断时没来得及记收据，也可以清掉
        //   其他来历不明的文字 → 保留，不动用户的东西
        let existing = cleanDraft(await editor.evaluate(el => el.innerText));
        if (existing) {
          const known = new Set([...this.receipts().operations.map(item => cleanDraft(item.text)), text]);
          const knownHit = [...known].some(item => item && (item === existing || existing.includes(item) || item.includes(existing)));
          if (!knownHit && !await looksLikeOurTemplate(existing)) {
            return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论输入框已有其他草稿，已保留原内容。' };
          }
          await clearEditor(page, editor);
          existing = cleanDraft(await editor.evaluate(el => el.innerText));
          if (existing) {
            return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '评论输入框无法清空，草稿已保留。' };
          }
        }
        const before = await this.snapshotComments(page);

        stop(signal);
        if (!await ensureEditorText(page, editor, text, { random: this.random, signal })) {
          return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '评论输入框回读与待发文字不一致，未发布。' };
        }

        const send = await this.findSend(page, signal);
        if (!send) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '没有找到发布按钮，未发布。' };

        await authorized('before-click');
        const releaseDispatch = await authorize.beginDispatch();
        if (typeof releaseDispatch !== 'function') throw new Error('最终发布未取得可释放的本机许可。');
        try {
          const point = await this.clickPoint(send);
          await this.clearPointerBlockers(page, point, signal);
          this.record(operation); clicked = true;
          await humanClick(page, point, { random: this.random, signal });
        } finally { releaseDispatch(); }

        // 成功判据：评论条数增加，且首条是新发的那条（相对时间显示「刚刚」或文本命中）。
        // 实测发布后输入框不清空，故不用「草稿清空」当条件。
        // 15s 太短：页面忙碌时一次 snapshot 就要 1-2 秒，新评论渲染也要时间，实测确认耗时 18-25 秒。
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          stop(signal);
          await waitForCommentTick(400, undefined, { signal });
          const now = await this.snapshotComments(page);
          const grew = now.count > before.count;
          const isOurs = now.firstIsJustNow || now.firstText.includes(text.slice(0, Math.min(8, text.length)));
          if (grew && isOurs) {
            const result = { confirmed: true, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId };
            this.record({ ...operation, status: 'confirmed', completedAt: new Date().toISOString() });
            return result;
          }
        }
        this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
        return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '已点击发布，但没有确认到新评论出现，请核对。' };
      }, { signal, autonomousRunId });
    } catch (error) {
      if (clicked) {
        try { this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() }); } catch { /* 保留原收据。 */ }
        return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '发布后中断，结果不明，请核对。' };
      }
      return { confirmed: false, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId, ...(error.needsUserAction ? { needsUserAction: true } : {}), reason: error.message || '发布前检查未通过。' };
    } finally { release(); }
  }

  // 取元素中心点坐标，交给类人点击。
  async clickPoint(locator) {
    const box = await locator.boundingBox();
    if (!box || box.width < 2 || box.height < 2) throw new Error('发布按钮位置不可用，未点击。');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async close() { if (this.ownsController) await this.controller.close(); }
}
