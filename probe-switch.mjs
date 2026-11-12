import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
const page = browser.contexts().flatMap(c => c.pages()).find(p => !p.isClosed() && /modal_id|\/video\//.test(p.url()));

// 先确保在播
await page.evaluate(async () => {
  const v = [...document.querySelectorAll('video')].find(v => { const r = v.getBoundingClientRect(); return Math.abs(r.y) < 10 && r.width > 500; });
  if (v) await v.play();
});
await page.waitForTimeout(1500);
const s1 = await page.evaluate(() => {
  const v = [...document.querySelectorAll('video')].find(v => { const r = v.getBoundingClientRect(); return Math.abs(r.y) < 10 && r.width > 500; });
  return { paused: v?.paused, t: v?.currentTime?.toFixed(2), dur: v?.duration };
});
console.log("播放状态:", JSON.stringify(s1));

// 滚轮切换
const box = await page.evaluate(() => {
  const v = [...document.querySelectorAll('video')].find(v => { const r = v.getBoundingClientRect(); return Math.abs(r.y) < 10 && r.width > 500; });
  const r = v.getBoundingClientRect();
  return { cx: r.x + r.width/2, cy: r.y + r.height/2 };
});
console.log("滚轮位置:", JSON.stringify(box));
const beforeId = /(\d{10,30})/.exec(page.url())?.[1];
await page.mouse.move(box.cx, box.cy, { steps: 12 });
await page.waitForTimeout(400);
await page.mouse.wheel(0, 700);
await page.waitForTimeout(4000);
const afterId = /(\d{10,30})/.exec(page.url())?.[1];
console.log("切换:", beforeId, "→", afterId, beforeId !== afterId ? "成功 ✓" : "失败 ✗");
await browser.close().catch(() => {});