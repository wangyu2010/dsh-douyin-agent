import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9227");
const page = browser.contexts().flatMap(c => c.pages()).find(p => !p.isClosed() && /douyin\.com/.test(p.url()));
const info = await page.evaluate(() => {
  // 页面上所有含"评论"的计数显示
  const counts = [];
  for (const e of document.querySelectorAll('*')) {
    const t = (e.textContent||'').trim();
    if (/^\d+$/.test(t) && /评论/.test(e.parentElement?.textContent||'')) {
      const r = e.getBoundingClientRect();
      if (r.width > 0) counts.push(t);
    }
  }
  // 评论区容器
  const list = document.querySelector('[data-e2e="comment-list"]');
  return {
    url: location.href,
    itemCount: document.querySelectorAll('[data-e2e="comment-item"]').length,
    commentListExists: !!list,
    listHeight: list ? { scroll: list.scrollHeight, client: list.clientHeight } : null,
    visibleTextHint: (document.body.innerText||'').slice(0, 300),
    counts: [...new Set(counts)].slice(0,5),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close().catch(() => {});