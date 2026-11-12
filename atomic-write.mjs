// 全项目唯一的原子写实现。所有模块都必须用它，不要再各自写一份。
//
// 为什么必须统一：这个项目里原本有二十多个各自实现的 write()，每份都「先写 tmp 再 rename」。
// 在 Windows 上，rename 覆盖一个正被别的句柄打开的目标会直接抛 EPERM。
// 而我修好一个模块的 write，其它模块仍然会炸——事实上就是这样：activity 修了 video-limits 的，
// 而观看循环用的是 autonomous-watch 里那份，于是 watch-loop.lock 继续 EPERM，整轮观看继续死。
//
// 这里负责三件事：
//   1. 同进程内对同一文件互斥，避免自己的两次写互相踩；
//   2. rename 遇到 EPERM/EBUSY/EACCES 时重试，扛住杀软、索引、读句柄的短暂占用；
//   3. 任何失败路径都清理临时文件，不留下垃圾。
//
// 注意：这里全部用同步原语（标记位 + 短忙等），不混用 Promise。
// 混用会导致：忙等期间微任务无法执行，等待条件永远不成立，死锁。
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const busy = new Set();
const spin = ms => { const end = Date.now() + ms; while (Date.now() < end) { /* 短忙等 */ } };
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST', 'ENOTEMPTY']);

// 写文件。失败会抛出原始错误，是否容忍由调用方决定：
// 统计类账本可以忽略，状态类必须让调用方知道。
export function writeJson(file, value, { attempts = 20, waitMs = 5000, mode = 0o600, spacing = 3, fsync = false } = {}) {
  const deadline = Date.now() + waitMs;
  while (busy.has(file)) {
    if (Date.now() > deadline) throw Object.assign(new Error('等待同文件写入超时。'), { code: 'EWRITELOCK' });
    spin(2);
  }
  busy.add(file);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    try {
      const body = JSON.stringify(value, null, 2);
      if (fsync) {
        const descriptor = fs.openSync(temporary, 'wx', mode);
        try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      } else {
        fs.writeFileSync(temporary, body, { mode, flag: 'wx' });
      }
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        fs.renameSync(temporary, file);
        return value;
      } catch (error) {
        lastError = error;
        if (!RETRYABLE.has(error.code)) break;
        // 退避：前几次快，后面慢，覆盖「杀软扫一下就好」和「文件被占几百毫秒」两种情况。
        spin(Math.min(200, spacing + attempt * 10));
      }
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw lastError;
  } finally {
    busy.delete(file);
  }
}

// 写失败只吞掉这类「环境性」错误，其它（磁盘满、路径不存在）照常抛。
export const isTransientWriteError = error => Boolean(error && RETRYABLE.has(error.code));

// 调用方不想关心写失败时用它：成功返回 true，失败返回 false 并把错误交给 onError。
export function writeJsonQuietly(file, value, onError) {
  try { writeJson(file, value); return true; }
  catch (error) {
    try { onError?.(error); } catch {}
    return false;
  }
}
