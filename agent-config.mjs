// 抖音运营助手的单一配置源。默认值内嵌在代码里，装完即用；文件只是覆盖，不是前提。
// 设计原则：AI 用工具改，人用指令说话，谁都不需要先学配置项。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { prepareCommentText } from './comment-text.mjs';

// 默认值即「开箱能用」：无人值守、时段覆盖日常、互动克制、频度可控。
export const AGENT_DEFAULTS = Object.freeze({
  version: 1,
  // 看视频
  watch: {
    enabled: true,
    // 全天：用户要的是无人值守，没理由让它在上午十点自己停下来等晚上八点。
    windows: ['00:00-24:00'],
    weekendWindows: null,          // null = 沿用 windows
    roundMinutesMin: 15,           // 每轮随机区间，固定时长本身是机器特征
    roundMinutesMax: 20,
    dailyMinutes: 1440,            // 每天最多看多少分钟（1440 就是“不限”）
    dailyRequests: 20000,          // 每天模型请求上限（含决策与评论生成）
    autoStart: true,               // 时段内自动开始，不用人点
    restartOnFailure: true,        // 单轮失败后自动重试，不停摆在原地
    retryBackoffSeconds: 180,      // 重试前等多久
    maxRetriesPerSlot: 3,          // 一个时段内最多重试几次
  },
  // 点赞（本地规则判定，不烧模型额度）
  like: {
    enabled: true,
    perRound: 3,
    perDay: 20,
    minWatchRatio: 0.55,           // 看够这个比例才值得点
    minGapSeconds: 90,             // 两次点赞最小间隔：太快会被看出是脚本
    likeProbability: 0.75,         // 不是每条达标都点，按比例抽样更像人
  },
  // 评论
  comment: {
    enabled: true,
    perRound: 1,
    perDay: 6,
    minGapSeconds: 240,            // 评论延迟：连续评论最容易触发流控
    maxGapSeconds: 600,
    visualCheck: true,             // 是否先截图核对画面
    minWatchRatio: 0.6,
    // 有模板就不调模型：正文从池里抽，再叠加轻微前后缀，实际组合上百。
    templates: null,               // null = 用内置模板池
  },
  // 收藏
  collect: { enabled: false, perRound: 1, perDay: 8 },
  // 节奏控制：所有互动共用的随机停顿，避免密集操作
  pace: {
    minGapSeconds: 45,
    maxGapSeconds: 180,
    idlePauseProbability: 0.15,    // 偶尔像人一样发呆一会儿
    idlePauseSecondsMin: 20,
    idlePauseSecondsMax: 90,
  },
});

const LIMITS = {
  'watch.roundMinutesMin': [1, 120], 'watch.roundMinutesMax': [1, 180],
  'watch.dailyMinutes': [1, 1440], 'watch.dailyRequests': [1, 20000],
  'watch.retryBackoffSeconds': [10, 3600], 'watch.maxRetriesPerSlot': [0, 20],
  'like.perRound': [0, 20], 'like.perDay': [0, 200],
  'like.minWatchRatio': [0, 1], 'like.minGapSeconds': [0, 3600], 'like.likeProbability': [0, 1],
  'comment.perRound': [0, 10], 'comment.perDay': [0, 100], 'comment.minGapSeconds': [0, 7200],
  'comment.maxGapSeconds': [0, 14400], 'comment.minWatchRatio': [0, 1],
  'collect.perRound': [0, 10], 'collect.perDay': [0, 100],
  'pace.minGapSeconds': [0, 3600], 'pace.maxGapSeconds': [0, 7200],
  'pace.idlePauseProbability': [0, 1],
  'pace.idlePauseSecondsMin': [0, 600], 'pace.idlePauseSecondsMax': [0, 1800],
};
const BOOLEANS = new Set(['watch.enabled', 'watch.autoStart', 'watch.restartOnFailure', 'like.enabled', 'comment.enabled', 'comment.visualCheck', 'collect.enabled']);
const ARRAY_OF_STRING = new Set(['watch.windows', 'watch.weekendWindows']);

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const clone = value => JSON.parse(JSON.stringify(value));
const at = (object, key) => key.split('.').reduce((node, part) => node?.[part], object);
const put = (object, key, value) => {
  const parts = key.split('.'), last = parts.pop();
  let node = object;
  for (const part of parts) { node[part] ??= {}; node = node[part]; }
  node[last] = value;
};

function parseWindow(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(value)) throw fail('时间段请用 HH:MM-HH:MM，例如 20:00-22:00。');
  const [startHour, startMinute, endHour, endMinute] = value.split(/[:-]/).map(Number);
  if (startHour > 23 || endHour > 24 || startMinute > 59 || endMinute > 59 || endHour === 24 && endMinute !== 0) throw fail('时间段超出范围。');
  if (startHour * 60 + startMinute === endHour * 60 + endMinute) throw fail('时间段不能为零长度。');
  return value;
}

// 逐项校验：只接受已知键，越界夹回合法范围并如实告知，不让一个坏值废掉整份配置。
function coerce(key, value) {
  if (BOOLEANS.has(key)) {
    if (typeof value !== 'boolean') throw fail(`${key} 需要 true 或 false。`);
    return { value };
  }
  // 评论模板：null 表示用内置池；数组表示自定义，逐条过公开校验，避免配进违规内容。
  if (key === 'comment.templates') {
    if (value === null) return { value: null };
    if (!Array.isArray(value) || value.length > 200) throw fail('评论模板需要 null 或最多 200 条字符串数组。');
    const list = [];
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) throw fail('评论模板每条都需要非空字符串。');
      list.push(prepareCommentText(item));
    }
    return { value: list };
  }
  if (ARRAY_OF_STRING.has(key)) {
    if (value === null && key === 'watch.weekendWindows') return { value: null };
    if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw fail(`${key} 需要 1 至 16 个时间段。`);
    for (const item of value) parseWindow(item);
    return { value: [...new Set(value)] };
  }
  if (key === 'watch.windows' || key === 'watch.weekendWindows') return { value };
  const range = LIMITS[key];
  if (!range) throw fail(`不支持的配置项：${key}`);
  const [min, max] = range;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(`${key} 需要一个数字。`);
  const clamped = Math.min(max, Math.max(min, value));
  return { value: Number.isInteger(value) ? Math.round(clamped) : clamped, clamped: clamped !== value };
}

// 把「看起来像配置」的输入拍平成点号键，允许嵌套对象和直接传 key，两种写法都认。
// version / updatedAt 是文件自带的元数据，不属于可配置项，读回时忽略。
const META_KEYS = new Set(['version', 'updatedAt']);
export function flattenPatch(input, prefix = '', out = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('配置需要是对象。');
  for (const [key, value] of Object.entries(input)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (!prefix && META_KEYS.has(key)) continue;
    const isWindowKey = ARRAY_OF_STRING.has(full);
    if (value && typeof value === 'object' && !Array.isArray(value) && !isWindowKey) flattenPatch(value, full, out);
    else out.push([full, value]);
  }
  return out;
}

export function validateAgentConfig(input) {
  const patch = flattenPatch(input), config = clone(AGENT_DEFAULTS), notes = [];
  for (const [key, raw] of patch) {
    const { value, clamped } = coerce(key, raw);
    put(config, key, value);
    if (clamped) notes.push(`${key} 已调整到合法范围 ${value}。`);
  }
  if (config.watch.roundMinutesMin > config.watch.roundMinutesMax) throw fail('每轮最短时长不能大于最长时长。');
  if (config.comment.minGapSeconds > config.comment.maxGapSeconds) throw fail('评论最小间隔不能大于最大间隔。');
  if (config.pace.minGapSeconds > config.pace.maxGapSeconds) throw fail('互动最小间隔不能大于最大间隔。');
  return { config, notes };
}

export class AgentConfig {
  constructor({ stateDir = resolveRuntimePaths().stateDir, clock = Date.now } = {}) {
    Object.assign(this, { stateDir, clock });
    this.file = path.join(stateDir, 'agent.json');
  }
  // 热读取：每次都用最新文件，AI 改完下一轮决策立即生效，不需要重启。
  read() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { config: clone(AGENT_DEFAULTS), notes: [], source: 'defaults' };
      // 文件坏了不能拖垮观看：退回默认值并如实标注，但不覆盖原文件。
      return { config: clone(AGENT_DEFAULTS), notes: ['配置文件无法解析，本次按默认值运行，原文件未改动。'], source: 'fallback' };
    }
    try {
      const { config, notes } = validateAgentConfig(raw);
      return { config, notes, source: 'file' };
    } catch (error) {
      return { config: clone(AGENT_DEFAULTS), notes: [`配置文件不合法（${error.message}），本次按默认值运行。`], source: 'fallback' };
    }
  }
  get() { return this.read().config; }
  // 只写差异；不传的项保持文件里已有的值，避免「改一个参数把别的重置」。
  update(input) {
    const patch = flattenPatch(input);
    if (!patch.length) throw fail('没有要修改的配置项。');
    const current = this.read();
    const draft = clone(current.config);
    const notes = [];
    for (const [key, raw] of patch) {
      const { value, clamped } = coerce(key, raw);
      put(draft, key, value);
      if (clamped) notes.push(`${key} 已调整到合法范围 ${value}。`);
    }
    if (draft.watch.roundMinutesMin > draft.watch.roundMinutesMax) throw fail('每轮最短时长不能大于最长时长。');
    if (draft.comment.minGapSeconds > draft.comment.maxGapSeconds) throw fail('评论最小间隔不能大于最大间隔。');
    if (draft.pace.minGapSeconds > draft.pace.maxGapSeconds) throw fail('互动最小间隔不能大于最大间隔。');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...draft, updatedAt: new Date(this.clock()).toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return { config: this.get(), changed: patch.map(([key]) => key), notes, file: this.file };
  }
  reset() {
    try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { config: this.get(), changed: ['*'], notes: ['已恢复默认配置。'], file: this.file };
  }
  // 给模型看的人话摘要，避免它去读文件。
  summarize() {
    const { config, notes, source } = this.read(), w = config.watch;
    const yes = value => value ? '开' : '关';
    return {
      source, notes,
      watch: { 开关: yes(w.enabled), 自动开始: yes(w.autoStart), 时段: w.windows, 每轮分钟: [w.roundMinutesMin, w.roundMinutesMax], 每日分钟: w.dailyMinutes, 每日请求: w.dailyRequests, 失败重试: yes(w.restartOnFailure) },
      like: { 开关: yes(config.like.enabled), 每轮: config.like.perRound, 每日: config.like.perDay, 最小观看比例: config.like.minWatchRatio },
      comment: { 开关: yes(config.comment.enabled), 每轮: config.comment.perRound, 每日: config.comment.perDay, 间隔秒: [config.comment.minGapSeconds, config.comment.maxGapSeconds] },
      collect: { 开关: yes(config.collect.enabled), 每轮: config.collect.perRound, 每日: config.collect.perDay },
      pace: { 互动间隔秒: [config.pace.minGapSeconds, config.pace.maxGapSeconds] },
    };
  }
  // 给用户听的白话说明：第一次使用或用户问「默认怎么配的」时直接念这段，
  // 不让用户去读配置项，也不用打开设置界面。
  describe() {
    const { config: c, source } = this.read(), w = c.watch;
    const allDay = w.windows.length === 1 && w.windows[0] === '00:00-24:00';
    const windowText = w.windows.join('、').replace(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/g, (_, h1, m1, h2, m2) => `${Number(h1)}点到${Number(h2)}点`);
    const lines = [
      allDay && w.dailyMinutes >= 1440
        ? `看视频：全天都能看，不限时段、不限总时长，每轮 ${w.roundMinutesMin} 到 ${w.roundMinutesMax} 分钟（随机，不是固定值）。单轮失败会自动重试，不用你管。`
        : allDay
          ? `看视频：全天都能看，每天最多 ${w.dailyMinutes} 分钟，每轮 ${w.roundMinutesMin} 到 ${w.roundMinutesMax} 分钟。单轮失败会自动重试，不用你管。`
          : `看视频：每天 ${windowText} 自动开始，每轮 ${w.roundMinutesMin} 到 ${w.roundMinutesMax} 分钟（随机，不是固定值），每天最多 ${w.dailyMinutes} 分钟。单轮失败会自动重试，不用你管。`,
      `点赞：开着，每轮最多 ${c.like.perRound} 个、每天最多 ${c.like.perDay} 个，两次之间隔 ${c.like.minGapSeconds} 秒以上。`,
      `评论：开着，每轮最多 ${c.comment.perRound} 条、每天最多 ${c.comment.perDay} 条，两条之间隔 ${Math.round(c.comment.minGapSeconds / 60)} 到 ${Math.round(c.comment.maxGapSeconds / 60)} 分钟。内容是内置的通用赞美，随机挑，不调用模型。`,
      `收藏：${c.collect.enabled ? `开着，每轮最多 ${c.collect.perRound} 个、每天最多 ${c.collect.perDay} 个` : '默认关着'}。`,
      `关注：不做。`,
      `节奏：动作之间随机停 ${c.pace.minGapSeconds} 到 ${c.pace.maxGapSeconds} 秒，偶尔会像人一样停顿一会儿。`,
    ];
    if (source === 'defaults') lines.push('以上都是内置默认值，你没有改过配置，装完就能直接用。');
    if (source === 'fallback') lines.push('注意：配置文件读不出来，这次按内置默认值运行，原文件没动。');
    lines.push('想改哪一项，直接跟我说一句话就行，例如「每天刷两小时」「评论别太频繁」。');
    return { source, text: lines.join('\n') };
  }
}
