// 公开评论文字：先修复不可见字符、换行与@提及，再核对真正不能公开的内容边界。
// 修复只做「不改变语义的机械清理」，联系方式、链接、凭据仍整条拒绝，由上层跳过而不是中断观看。
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export const COMMENT_TEXT_LIMIT = 200;
// 控制符、零宽字符、双向覆盖符、BOM、行分隔符、私用区：在编辑器里会吞字或被判为异常输入。
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;
const PRIVATE_USE = /[\uE000-\uF8FF]/g;
const SPACES = /[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g;
const MENTION = /[@＠]\s*[\p{L}\p{N}_.\-·]{1,30}/gu;
const STRAY_MENTION = /[@＠]+/gu;
// 邮箱形状的@不是「提及」，不能靠剥离绕过检查，原样保留交给边界校验拒绝。
const EMAIL_LIKE = /[a-z0-9._%+-]+\s*[@＠]\s*[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
const SENTENCE = /[。！？!?…；;]/u;

// 只拒绝真正不能公开的内容；「账号」「好友」「联系人」等普通词不再误杀。
const BLOCKED = /[@＠]|https?:|www\.|(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|dev|app|me|top|xyz|co|tv)\b|(?:\d[\s-]*){7,}|sk[-_][a-z0-9_-]{6,}|api[\s_-]*key|token|cookie|password|密钥|口令|验证码|身份证|手机号|手机号码|私聊|私信|微信|QQ|加我/iu;
const PROMISE = /(?:我|我们|大肥鱼).{0,8}(?:保证|承诺|负责|一定(?:会|帮|给|送)|会(?:联系|见面|到场|付款|购买|送|转账|打钱|帮你))|(?:我|我们).{0,6}(?:亲自|实测|用过|去过|见过|买过|吃过|听完|看完)/u;

export function graphemeClusters(text) {
  const value = String(text ?? '');
  try { return [...new Intl.Segmenter('zh-Hans', { granularity: 'grapheme' }).segment(value)].map(item => item.segment); }
  catch { return Array.from(value); }
}

function clip(text, limit = COMMENT_TEXT_LIMIT) {
  const clusters = graphemeClusters(text);
  if (clusters.length <= limit) return text;
  // 超长时尽量在整句处截断，避免半个字或半个表情。
  const head = clusters.slice(0, limit).join('');
  for (let index = head.length - 1; index >= Math.floor(head.length * 0.6); index--) {
    if (SENTENCE.test(head[index])) return head.slice(0, index + 1);
  }
  return head.replace(/[\s，,、,；;：:·]+$/u, '');
}

// 机械修复：不可见字符、换行、@提及、异常空白与超长；不改写正文用词。
export function sanitizeCommentText(value) {
  if (typeof value !== 'string') throw fail('评论须为 1 至 200 字的单段纯文字。');
  // 先把换行/制表变成空格，再剔除其余控制符，避免两行文字粘成一行。
  let text = value.replace(/\r\n?/g, '\n').replace(/[\n\t]+/g, ' ');
  text = text.replace(INVISIBLE, '').replace(PRIVATE_USE, '');
  // 邮箱一类的联系方式不剥离，原样保留，交给边界校验整条拒绝。
  const protectedEmail = EMAIL_LIKE.test(text);
  if (!protectedEmail) text = text.replace(MENTION, ' ').replace(STRAY_MENTION, ' ');
  text = text.replace(SPACES, ' ').trim();
  text = clip(text).replace(SPACES, ' ').trim();
  if (!text) throw fail('评论在清除非公开内容后为空，未发布。');
  return text;
}

export function validateCommentText(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > COMMENT_TEXT_LIMIT || /[\x00-\x1f\x7f\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/.test(value)) throw fail('评论须为 1 至 200 字的单段纯文字。');
  const text = value.trim(), folded = text.normalize('NFKC');
  if (BLOCKED.test(folded)) throw fail('公开评论不能包含@、链接、联系方式、密钥或私人聊天与好友信息。', 400);
  if (PROMISE.test(folded)) throw fail('评论只能谈当前有限观察，不能编造现实经历或作现实承诺。', 400);
  return text;
}

// 发布前唯一入口：先修复可修复的特殊字符，再按公开边界核对。
export function prepareCommentText(value) { return validateCommentText(sanitizeCommentText(value)); }
