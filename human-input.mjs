// 类人输入：把「瞬间瞬移 + 固定 10ms 打字」改成有轨迹、有节奏抖动、有单词停顿的输入。
// 只影响输入节奏与鼠标轨迹，不改动任何授权、几何见证、收据或去重规则。
import { createHash } from 'node:crypto';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
// 所有随机取值都必须走同一个随机源，否则固定种子也无法复现。
const between = (min, max, random = Math.random) => min + random() * (max - min);
// 可复现的随机源，测试里固定种子即可得到稳定节奏。
export function createRandom(seed) {
  if (seed === undefined || seed === null) return Math.random;
  // 种子先散列成 32 位整数，再跑 xorshift32；同一个种子永远得到同一串节奏。
  const digest = createHash('sha256').update(String(seed)).digest();
  let state = (digest.readUInt32LE(0) || 1) >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

// 中文/全角字符按「逐字」节奏，拉丁字母与数字按「词内较快」，标点后停顿更久。
export function typingDelay(character, random = Math.random) {
  const base = /[\u3000-\u9FFF\uFF00-\uFFEF]/u.test(character) ? between(95, 210, random)
    : /[a-zA-Z0-9]/u.test(character) ? between(55, 125, random)
    : between(70, 160, random);
  const pause = /[，,。.！!？?；;：:、…]/u.test(character) ? between(140, 420, random)
    : /[\s]/u.test(character) ? between(60, 180, random) : 0;
  // 偶发的思考停顿，让整段节奏不像固定采样。
  const hiccup = random() < 0.06 ? between(240, 700, random) : 0;
  return Math.round(clamp(base + pause + hiccup, 25, 1200));
}

function stepsFor(distance, random) {
  const step = clamp(Math.round(distance / between(45, 90, random)), 8, 60);
  return step + Math.round(between(0, 6, random));
}

// 贝塞尔近似的人手轨迹：轻微过冲 + 末段减速，避免一条直线和零加速度。
export function humanePath(from, to, random = Math.random) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 2) return [{ x: to.x, y: to.y, delay: Math.round(between(20, 60, random)) }];
  const steps = stepsFor(distance, random);
  const curveX = between(-0.22, 0.22, random) * distance, curveY = between(-0.22, 0.22, random) * distance;
  const mid = (t) => {
    const control = { x: (from.x + to.x) / 2 + curveX, y: (from.y + to.y) / 2 + curveY };
    const inverse = 1 - t;
    return { x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x, y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y };
  };
  const path = [];
  for (let index = 1; index <= steps; index++) {
    const raw = index / steps, eased = 1 - Math.pow(1 - raw, 2.6);
    const point = mid(eased);
    const jitterScale = (1 - eased) * 0.8 + 0.2;
    path.push({ x: point.x + between(-1.1, 1.1, random) * jitterScale, y: point.y + between(-1.1, 1.1, random) * jitterScale, delay: Math.round(between(9, 26, random) / (0.6 + eased)) });
  }
  path.push({ x: to.x, y: to.y, delay: Math.round(between(30, 90, random)) });
  return path;
}

// 让鼠标沿人手轨迹移到目标（不点击），用于滚轮换片这类本来就不是点击的输入。
export async function moveHuman(page, point, { random = Math.random, signal } = {}) {
  signal?.throwIfAborted();
  // 合成页面可能没有鼠标接口；此时退化为不移动，点击本身仍由调用方完成。
  if (typeof page?.mouse?.move !== 'function') return;
  const origin = page.__deepseekLastPointer;
  const from = origin && Number.isFinite(origin.x) ? origin : { x: point.x + between(-90, 90, random), y: point.y + between(-70, 70, random) };
  for (const step of humanePath(from, point, random)) {
    signal?.throwIfAborted();
    await page.mouse.move(step.x, step.y);
    await new Promise(resolve => setTimeout(resolve, step.delay));
  }
  page.__deepseekLastPointer = { x: point.x, y: point.y };
}

// 真实点击：先按人手轨迹移入，再用一次真实 click 完成按下与抬起，不额外产生事件。
export async function humanClick(page, point, { random = Math.random, signal } = {}) {
  await moveHuman(page, point, { random, signal });
  signal?.throwIfAborted();
  // 轨迹已经把人手停在目标上；这里用单次 click（含短按下时长），仍只有一个点击事件。
  await page.mouse.click(point.x, point.y, { delay: Math.round(between(35, 95, random)) });
  page.__deepseekLastPointer = { x: point.x, y: point.y };
}

export async function typeHumanly(page, text, { random = Math.random, signal, onCharacter } = {}) {
  const characters = Array.from(text);
  for (const [index, character] of characters.entries()) {
    signal?.throwIfAborted();
    await page.keyboard.type(character);
    await onCharacter?.(character, index);
    await new Promise(resolve => setTimeout(resolve, typingDelay(character, random)));
  }
}

// 受控编辑器（DraftEditor 等）会丢字，也可能把输入法组合事件当异常；这里只做「补齐」不做覆盖。
export async function readEditorText(locator) {
  return locator.evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText);
}

export function normalizeDraft(value) { return String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim(); }

// 清空编辑器。Draft 用 execCommand 直接改 DOM 会让内部 state 与 DOM 脱节（表现为内容反复累加），
// 必须先聚焦、全选、再按退格，让 Draft 自己处理删除。
export async function clearEditor(page, locator) {
  await locator.click({ timeout: 5000 }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 120));
  await page.keyboard.press('Control+A');
  await new Promise(resolve => setTimeout(resolve, 80));
  await page.keyboard.press('Backspace');
  await new Promise(resolve => setTimeout(resolve, 200));
  // 还残留就再多删几次（Draft 偶尔需要逐段删）。
  for (let i = 0; i < 3; i++) {
    const left = normalizeDraft(await readEditorText(locator));
    if (!left) return;
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

// DraftEditor 必须先真实点击把焦点放进去，否则首字会被吞。
// 实测：insertText 对 Draft 会插在光标处不可靠；先点击再逐字 type 才是稳定的。
export async function ensureEditorText(page, locator, text, { random = Math.random, signal, attempts = 3 } = {}) {
  const expected = normalizeDraft(text);
  let current = normalizeDraft(await readEditorText(locator));
  if (current === expected) return true;
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    // 已有不属于本次待发文字的内容：不覆盖，交给上层保留。
    if (current && !expected.includes(current)) return false;
    await clearEditor(page, locator);
    current = normalizeDraft(await readEditorText(locator));
    if (current) continue;
    // 关键：真实点击编辑器，等焦点稳定，再逐字输入。
    await locator.click({ timeout: 5000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, Math.round(between(150, 320, random))));
    await typeHumanly(page, expected, { random, signal });
    await new Promise(resolve => setTimeout(resolve, Math.round(between(150, 300, random))));
    current = normalizeDraft(await readEditorText(locator));
    if (current === expected) return true;
  }
  return current === expected;
}
