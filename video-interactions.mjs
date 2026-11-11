// 作品互动（点赞/收藏）：只点页面上真实存在、且在当前可见区域里的那一个按钮。
// 抖音的推荐流是轮播，同一时刻 DOM 里会有相邻几条的按钮；用视口筛出唯一一个再点。
// 不做关注——关注会改变账号关系，属于不可轻易撤销的动作。

// 抖音用 data-e2e-state 表达选中态。这是实测到的真实属性值：
// 未点赞是 video-player-no-digged，已点赞是 video-player-is-digged。
// aria-pressed 和 svg 填充色在这套页面上读不出来，别用。
const TARGETS = {
  like: { selector: '[data-e2e="video-player-digg"]', on: 'video-player-is-digged', off: 'video-player-no-digged', label: '点赞' },
  collect: { selector: '[data-e2e="video-player-collect"]', on: 'video-player-is-collected', off: 'video-player-no-collect', label: '收藏' },
};

// 一次 evaluate 拿全：找到视口内唯一可见的目标，读它的选中态和坐标。
// 注意：这个函数会被序列化后送进页面执行，不能引用模块作用域，所以 target 由参数传入。
function readInPage(target) {
  const all = [...document.querySelectorAll(target.selector)];
  const events = [];
  let index = -1;
  all.forEach((node, i) => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    if (!(rect.width > 0 && rect.height > 0)) return;
    if (style.display === 'none' || style.visibility === 'hidden') return;
    // 必须整块在当前视口里，相邻轮播项的按钮在视口外，正好排除。
    if (!(rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth)) return;
    if (index === -1) index = i;
    events.push({ node, rect });
  });
  if (!events.length) return { found: false, count: 0, total: all.length };
  if (events.length > 1) return { found: true, count: events.length, ambiguous: true };
  const { node, rect } = events[0], state = node.getAttribute('data-e2e-state');
  // 只认这两个确定值；其它取值（含 null）一律当作读不到，交给调用方按结果不明处理。
  const pressed = state === target.on ? true : state === target.off ? false : null;
  return { found: true, count: 1, index, pressed, state, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// 只读：不产生任何点击，用于决策前判断本来就点过没有。
export async function readInteractionState(scope, action) {
  const target = TARGETS[action];
  if (!target) throw new Error(`不支持的互动动作：${action}`);
  return { action, ...(await scope.evaluate(readInPage, target)) };
}

// 点击并核对。成功条件是 data-e2e-state 从 off 翻到 on。
// 失败一律抛错或返回 changed:false，由调用方记跳过；绝不清空、不补点第二次。
export async function toggleInteraction(scope, action, { verifyMs = 4000 } = {}) {
  const target = TARGETS[action];
  if (!target) throw new Error(`不支持的互动动作：${action}`);
  const before = await scope.evaluate(readInPage, target);
  if (!before.found) throw Object.assign(new Error(`当前画面里没有找到${target.label}按钮（页面上共 ${before.total ?? 0} 个，都不在可见区域）。`), { code: 'INTERACTION_TARGET_MISSING' });
  if (before.ambiguous) throw Object.assign(new Error(`${target.label}按钮在当前画面里不唯一（${before.count} 个），未点击。`), { code: 'INTERACTION_TARGET_AMBIGUOUS' });
  // 已选中还点会取消，反而少一个：直接返回，不产生点击。
  if (before.pressed === true) return { action, changed: false, already: true, pressedBefore: true, pressedAfter: true, reason: `${target.label}原本已选中，没有重复点击。` };

  // 按读到的下标点那一个：.first() 会命中视口外的相邻轮播项，Playwright 会因「元素在视口外」一直重试到超时。
  // 不能用 force：force 绕过命中检测，页面的事件处理收不到这次点击，状态不会变（实测过）。
  // 真人操作是先移过去再按下，这里用鼠标分步移动还原这个过程。
  await scope.mouse.move(before.x, before.y, { steps: 10 + Math.floor(Math.random() * 8) });
  await scope.waitForTimeout(120 + Math.floor(Math.random() * 180));
  await scope.mouse.click(before.x, before.y, { delay: 40 + Math.floor(Math.random() * 70) });

  const deadline = Date.now() + verifyMs;
  let after = before;
  while (Date.now() < deadline) {
    await scope.waitForTimeout(150);
    after = await scope.evaluate(readInPage, target);
    if (after.pressed === true) return { action, changed: true, pressedBefore: before.pressed, pressedAfter: true, reason: `${target.label}已生效。` };
    if (!after.found) break; // 按钮消失说明页面已经变了，不用再等。
  }
  return { action, changed: false, pressedBefore: before.pressed, pressedAfter: after.pressed ?? null, reason: `点击后没有读回选中的${target.label}状态。` };
}

export { TARGETS as INTERACTION_TARGETS };
