// 互动（点赞 / 评论 / 收藏）的本地决策层：不调模型，只做判定、抽模板、控频。
// 控频是防流控的唯一可靠位置：模型自觉不可靠，闸门可测、可审计、可回放。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { prepareCommentText } from './comment-text.mjs';

// 中性通用赞美：任何视频都能用，不会说错话，也不含 @、链接、联系方式。
const CORE_TEMPLATES = [
  '这条讲得很清楚，学到了',
  '画面质感真好，看着舒服',
  '内容很实用，值得一看',
  '这个思路挺特别的',
  '讲得挺到位，受教了',
  '节奏把握得不错',
  '干货满满，支持一下',
  '这个角度很新颖',
  '看着很舒服，收藏了',
  '简洁明了，说得好',
  '这个表达方式我喜欢',
  '讲得很实在',
  '有被启发到',
  '这个细节处理得好',
  '看得很过瘾',
  '挺有意思的，继续加油',
  '内容质量很高',
  '这个观点站得住',
  '说得在理',
  '画面和内容都用心了',
  '很有共鸣',
  '这个选题好',
  '讲得明白易懂',
  '这个思路可以借鉴',
  '看完了，挺有收获',
  '整体完成度很高',
  '这个表达很自然',
  '值得反复看',
  '这个分享很有价值',
  '讲得不啰嗦，舒服',
  '这个角度想到位了',
  '画面干净，看着不累',
  '内容扎实',
  '这个节奏很对',
  '说得挺透彻',
  '挺有想法的',
  '这个处理方式聪明',
  '看完有学到东西',
];

// 轻微前缀/后缀：与主句组合出上百种实际文本，降低重复率但不改变中性赞美语义。
const PREFIXES = ['', '', '', '', '说真的，', '不得不说，', '讲真，', '看完觉得，', '这回，', '整体上，'];
const SUFFIXES = ['', '', '', '', '，支持一下', '，继续加油', '，学到了', '，收藏了', '，期待更多', '。'];

const DAY_MS = 86_400_000;
const dateKey = now => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);

function read(file, fallback) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) throw new Error();
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    // 账本坏了不能拖垮观看：按空账本继续，但绝不覆盖原文件。
    return { ...fallback, corrupted: true };
  }
}
function write(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export class InteractionGate {
  constructor({ stateDir = resolveRuntimePaths().stateDir, getConfig, clock = Date.now, random = Math.random } = {}) {
    Object.assign(this, { stateDir, getConfig, clock, random });
    this.file = path.join(stateDir, 'interaction-ledger.json');
    // 每轮计数只存在内存里：新一轮就是新一轮，不跨轮累计。
    this.round = { likes: 0, comments: 0, collects: 0 };
  }
  config() { return this.getConfig?.() ?? { like: { enabled: false }, comment: { enabled: false }, collect: { enabled: false }, pace: {} }; }
  ledger() {
    const value = read(this.file, { version: 1, days: {}, last: {} });
    if (!value || value.version !== 1 || typeof value.days !== 'object' || Array.isArray(value.days)) return { version: 1, days: {}, last: {} };
    return value;
  }
  newRound() { this.round = { likes: 0, comments: 0, collects: 0 }; }

  // 只看视频表现，不读模型意见。
  // 注意：观察只采样数秒，拿「播放进度/时长」当门槛会永远不达标；
  // 真正可信的依据是「确实播放过、没有暂停/失败、且有停留证据」。
  worthEngaging({ watchRatio, played, paused, failed, stayed } = {}) {
    const config = this.config();
    const verdict = { like: false, comment: false, collect: false, reason: '' };
    if (failed || paused || !played) { verdict.reason = '没有实际播放完成，不互动。'; return verdict; }
    const ratio = Number(watchRatio);
    // 采样时的进度比例只作为「有没有真在看」的弱信号，不能当主门槛。
    const watching = Number.isFinite(ratio) && ratio > 0;
    // 停留过（主动多看）是最强的正向依据；否则至少要有真实播放进度。
    const evidence = stayed === true || watching;
    if (!evidence) { verdict.reason = '缺少可信观看依据，不互动。'; return verdict; }
    verdict.like = config.like.enabled !== false && evidence;
    verdict.collect = config.collect.enabled === true && evidence;
    verdict.comment = config.comment.enabled !== false && evidence;
    verdict.reason = stayed === true ? '有停留证据，可以互动。' : '有真实播放进度，可以互动。';
    verdict.watchRatio = Number.isFinite(ratio) ? ratio : null;
    return verdict;
  }

  // 频度闸门：开启状态、每轮上限、每日上限、最小间隔，逐关检查。
  // 间隔是跨轮约束（上一轮评完，新一轮也要等），所以排在每轮上限之前判断。
  allowance(action) {
    const config = this.config(), policy = config[action === 'like' ? 'like' : action === 'collect' ? 'collect' : 'comment'];
    if (!policy || policy.enabled !== true) return { allowed: false, reason: `${action} 未开启。` };
    const key = action === 'like' ? 'likes' : action === 'collect' ? 'collects' : 'comments';
    const perRound = policy.perRound ?? 0, perDay = policy.perDay ?? 0;
    // 跨轮的最小间隔优先：即使新一轮计数清零，也要等够时间。
    const lastAt = this.ledger().last?.[action] ?? 0;
    const minGap = Math.max(policy.minGapSeconds ?? 0, 0) * 1000;
    if (lastAt && this.clock() - lastAt < minGap) {
      const waitSeconds = Math.ceil((minGap - (this.clock() - lastAt)) / 1000);
      return { allowed: false, reason: `${action}还需等待 ${waitSeconds} 秒。`, waitSeconds };
    }
    if (this.round[key] >= perRound) return { allowed: false, reason: `本轮${action}已到上限 ${perRound}。` };
    const ledger = this.ledger(), today = dateKey(this.clock()), used = ledger.days?.[today]?.[key] ?? 0;
    if (used >= perDay) return { allowed: false, reason: `今日${action}已到上限 ${perDay}。` };
    // 点赞/收藏随机抽样：不是每条达标都互动，稀疏本身就像人。
    if (action === 'like' && (policy.likeProbability ?? 1) < 1 && this.random() > policy.likeProbability) return { allowed: false, reason: '本次抽样跳过点赞。' };
    return { allowed: true, round: this.round[key], daily: used, perRound, perDay };
  }
  // action 可以带 :noop 后缀，表示「这条已经点过了」——照样占一次额度把它划掉，
  // 但不会让调用方误以为真的点成功了。
  record(action) {
    const base = String(action).split(':')[0];
    const key = base === 'like' ? 'likes' : base === 'collect' ? 'collects' : 'comments';
    this.round[key] = (this.round[key] ?? 0) + 1;
    const ledger = this.ledger(), today = dateKey(this.clock());
    ledger.days ??= {}; ledger.days[today] ??= {}; ledger.last ??= {};
    ledger.days[today][key] = (ledger.days[today][key] ?? 0) + 1;
    ledger.last[base] = this.clock();
    fs.mkdirSync(this.stateDir, { recursive: true });
    write(this.file, ledger);
    return { round: this.round[key], daily: ledger.days[today][key] };
  }

  // 抽模板：主句 + 轻微前后缀，实际组合数 = 38 × 10 × 10。
  pickCommentText() {
    const custom = this.config().comment?.templates;
    const pool = Array.isArray(custom) && custom.length ? custom.filter(item => typeof item === 'string' && item.trim()) : CORE_TEMPLATES;
    if (!pool.length) throw new Error('评论模板为空，未发布评论。');
    const pick = list => list[Math.floor(this.random() * list.length)];
    const text = `${pick(PREFIXES)}${pick(pool).replace(/[。！!]+$/u, '')}${pick(SUFFIXES)}`;
    // 仍然走公开校验：模板里若被改成含 @、链接或联系方式，这里会拒绝而不是发出去。
    return prepareCommentText(text);
  }
}

export { CORE_TEMPLATES };
