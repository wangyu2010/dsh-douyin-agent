import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9227");
const page = browser.contexts().flatMap(c => c.pages()).find(p => !p.isClosed() && /modal_id|\/video\//.test(p.url()));

const state = async () => page.evaluate(() => {
  const v = [...document.querySelectorAll("video")].find(v => { const r = v.getBoundingClientRect(); return Math.abs(r.y) < 10 && r.width > 500; });
  return { paused: v?.paused, t: v?.currentTime?.toFixed(2), id: /(\d{10,30})/.exec(location.href)?.[1] };
});

// 1) 暂停它
await page.evaluate(() => {
  const v = [...document.querySelectorAll("video")].find(v => { const r = v.getBoundingClientRect(); return Math.abs(r.y) < 10 && r.width > 500; });
  if (v) v.pause();
});
await page.waitForTimeout(500);
console.log("强制暂停后:", JSON.stringify(await state()));

// 2) 复刻 ensurePlaying 的逻辑
async function ensurePlaying(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const s = await state();
    if (s.paused === false) return { ok: true, attempt: i };
    await page.evaluate(async () => {
      const v = [...document.querySelectorAll("video")].find(v => { const r = v.getBoundingClientRect(); return Math.abs(r.y) < 10 && r.width > 500; });
      if (v) { try { await v.play(); } catch {} }
    });
    await page.waitForTimeout(300 + i * 400);
  }
  const f = await state();
  return { ok: f.paused === false, final: f };
}
const r = await ensurePlaying();
console.log("ensurePlaying:", JSON.stringify(r));

// 3) 恢复后能否正常切
const before = await state();
const box = await page.evaluate(() => {
  const v = [...document.querySelectorAll("video")].find(v => { const r = v.getBoundingClientRect(); return Math.abs(r.y) < 10 && r.width > 500; });
  const r = v.getBoundingClientRect();
  return { cx: r.x + r.width/2, cy: r.y + r.height/2 };
});
await page.mouse.move(box.cx, box.cy, { steps: 12 });
await page.waitForTimeout(400);
await page.mouse.wheel(0, 700);
await page.waitForTimeout(4000);
const after = await state();
console.log("切换:", before.id, "→", after.id, before.id !== after.id ? "成功 ✓" : "失败 ✗");
await browser.close().catch(() => {});