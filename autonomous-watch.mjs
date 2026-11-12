import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiAgent, redact, watchDecisionMessages, parseWatchDecision } from './api-agent.mjs?v=20';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { AutonomousShare, isSharePreflightNotSent } from './autonomous-share.mjs?v=9';
import { AutonomousComments } from './autonomous-comments.mjs?v=10';
import { PublicCommentAgent } from './public-comment-agent.mjs?v=9';
import { InteractionGate } from './interaction-gate.mjs';
import { AgentConfig } from './agent-config.mjs';
import { toggleInteraction } from './video-interactions.mjs';
import { DailyReport } from './daily-report.mjs?v=9';

import { WatchOptions } from './watch-options.mjs';
import { UsageLedger } from './usage-ledger.mjs';

export const WATCH_LIMITS = Object.freeze({ sampleSeconds: 3, maxLiveSkips: 3, maxSwitchFailures: 5 });
// 评论这一步没发出去不结束观看；连续多次修不好才停用本轮评论。
export const COMMENT_LIMITS = Object.freeze({ maxConsecutiveSkips: 3 });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('自主观看状态文件损坏，未重置预算或运行锁。'); } };
// 原子写统一走公共模块。原来这里有一份本地实现，没有重试和互斥；
// watch-loop.lock 就是用那份写的，EPERM 一来整轮观看直接死掉。
import { writeJson as write } from './atomic-write.mjs';
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const failure = (message, watchStatus = 'failed') => Object.assign(new Error(message), { watchStatus });
export function readShareProgress(value) {
  const keys=['total','currentIndex','completed','confirmed','notSent','skipped'];
  if(!value||!keys.every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||value.total<1||value.currentIndex>value.total||value.completed>value.currentIndex||value.confirmed+value.notSent+value.skipped>value.completed||!['sharing','completed','paused'].includes(value.status))return null;
  return Object.fromEntries([...keys.map(key=>[key,value[key]]),['status',value.status]]);
}
const isLivePreview = state => state?.pageKind === 'live-preview' && state.livePreview?.recognized === true && state.livePreview.source === 'active-feed-live-link' && state.livePreview.scope === 'recommend-feed' && /^\d{4,30}$/.test(state.livePreview.roomId || '');
const readyVideo = state => !isLivePreview(state) && /^\d{10,30}$/.test(state?.video?.id || '') && state.video.readyState >= 2;

function switchFailureDiagnostic({ name, output, error, source, runId, now, startedAt, expectedVideoId, stage }) {
  const hash = value => typeof value === 'string' && value.length > 0 && value.length <= 128 ? createHash('sha256').update(value).digest('hex') : null;
  const idHash = value => typeof value === 'string' && /^\d{1,64}$/.test(value) ? hash(value) : null;
  const number = (value, min = 0, max = 1_000_000_000) => Number.isFinite(value) && value >= min && value <= max ? value : null;
  const geometry = value => value && typeof value === 'object' ? Object.fromEntries(['x','y','width','height'].map(key => [key,number(value[key],key === 'x' || key === 'y' ? -1_000_000 : 0,1_000_000)])) : null;
  const video = value => value && typeof value === 'object' ? { idHash:idHash(value.id),readyState:Number.isInteger(value.readyState) ? number(value.readyState,0,4) : null,paused:typeof value.paused === 'boolean' ? value.paused : null,time:number(value.time),duration:number(value.duration),viewport:geometry(value.viewport) } : null;
  const code = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value) ? value : null;
  const state = output?.state || output || {},selection = state.videoSelection;
  return { version:1,kind:'video-switch-failure',at:new Date(now).toISOString(),source:['api','dsh'].includes(source)?source:null,runIdHash:hash(runId),tool:name,stage:stage==='autonomous-verification'?stage:error?'controller-exception':'controller-result',elapsedMs:number(now-startedAt,0,600_000),expectedVideoIdHash:idHash(expectedVideoId),changed:typeof output?.changed === 'boolean'?output.changed:null,reasonCode:code(output?.reasonCode)||code(error?.code),switchConfirm:['stable','id-seen'].includes(output?.switchConfirm)?output.switchConfirm:null,staleObservation:output?.staleObservation===true,before:video(output?.before),after:video(output?.after||state.video),selection:selection&&typeof selection==='object'?{candidateCount:Number.isSafeInteger(selection.candidateCount)?number(selection.candidateCount,0,512):null,ambiguous:selection.ambiguous===true,identityConflict:selection.identityConflict===true}:null,pageKind:['video','live-preview','search','unknown'].includes(state.pageKind)?state.pageKind:null,blocked:{loginRequired:state.loginRequired===true,verificationRequired:state.verificationRequired===true,privateChatVisible:state.privateChatVisible===true,unsupportedPage:state.unsupportedPage===true} };
}


function readSwitchDiagnostic(value) {
  if (!value || value.version !== 1 || value.kind !== 'video-switch-failure' || !['douyin_next','douyin_previous'].includes(value.tool)) return null;
  const number=(v,min=0,max=1_000_000_000)=>Number.isFinite(v)&&v>=min&&v<=max?v:null,hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:null;
  const geometry=v=>v&&typeof v==='object'?Object.fromEntries(['x','y','width','height'].map(key=>[key,number(v[key],key==='x'||key==='y'?-1_000_000:0,1_000_000)])):null;
  const video=v=>v&&typeof v==='object'?{idHash:hash(v.idHash),readyState:Number.isInteger(v.readyState)?number(v.readyState,0,4):null,paused:typeof v.paused==='boolean'?v.paused:null,time:number(v.time),duration:number(v.duration),viewport:geometry(v.viewport)}:null;
  const at=typeof value.at==='string'&&value.at.length<=40&&Number.isFinite(Date.parse(value.at))?new Date(value.at).toISOString():null,selection=value.selection;
  return{version:1,kind:'video-switch-failure',at,source:['api','dsh'].includes(value.source)?value.source:null,runIdHash:hash(value.runIdHash),tool:value.tool,stage:['controller-result','controller-exception','autonomous-verification'].includes(value.stage)?value.stage:null,elapsedMs:number(value.elapsedMs,0,600_000),expectedVideoIdHash:hash(value.expectedVideoIdHash),changed:typeof value.changed==='boolean'?value.changed:null,reasonCode:typeof value.reasonCode==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value.reasonCode)?value.reasonCode:null,switchConfirm:['stable','id-seen'].includes(value.switchConfirm)?value.switchConfirm:null,staleObservation:value.staleObservation===true,before:video(value.before),after:video(value.after),selection:selection&&typeof selection==='object'?{candidateCount:Number.isSafeInteger(selection.candidateCount)?number(selection.candidateCount,0,512):null,ambiguous:selection.ambiguous===true,identityConflict:selection.identityConflict===true}:null,pageKind:['video','live-preview','search','unknown'].includes(value.pageKind)?value.pageKind:null,blocked:Object.fromEntries(['loginRequired','verificationRequired','privateChatVisible','unsupportedPage'].map(key=>[key,value.blocked?.[key]===true]))};
}
// API 与原生入口通过同一锁、有限视频轮次和持久预算协调，不在重启时恢复循环。
export class AutonomousWatch {
  constructor({ controller, config = {}, videoLimits, personaMemory, agent, shareService, commentService, commentAgent, reportService, decisionProvider, stateDir = resolveRuntimePaths().stateDir, source = 'api', fetchImpl = fetch, now = Date.now, delayImpl = (ms, signal) => delay(ms, undefined, { signal }), onEvent = () => {} } = {}) {
    if (!controller?.execute || !videoLimits?.state || !personaMemory?.context || !['api', 'dsh'].includes(source)) throw new Error('自主观看缺少浏览器、时限或共同人格接口。');
    Object.assign(this, { controller, config, videoLimits, personaMemory, shareService, decisionProvider, stateDir, source, now, delayImpl, onEvent });
    this.optionsService = new WatchOptions({ stateDir });
    this.usageLedger = new UsageLedger({ stateDir, now });
    this.agent = agent || new ApiAgent({ controller, config, personaMemory, fetchImpl });
    Object.assign(this, { commentService, reportService });
    this.agent.usageLedger = this.usageLedger; this.agent.source = source;
    this.commentAgent = commentAgent || new PublicCommentAgent({ config, fetchImpl });
    this.commentAgent.usageLedger = this.usageLedger; this.commentAgent.source = source;
    fs.mkdirSync(stateDir, { recursive: true });
    this.files = Object.fromEntries(['lock', 'guard', 'budget', 'state', 'stop'].map(name => [name, path.join(stateDir, `watch-${name === 'lock' ? 'loop.lock' : name === 'guard' ? 'control.guard' : name === 'stop' ? 'stop.request.json' : name + '.json'}`)]));
    this.files.manual = path.join(stateDir, 'watch-manual.lock');
    this.running = false; this.completion = null; this.abort = null; this.runId = null; this.sessionId = null;
  }
  control(action) {
    let descriptor; const token = randomUUID();
    try { descriptor = fs.openSync(this.files.guard, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('自主观看控制记录正被使用，请稍后重试。'), { status: 409, code: 'WATCH_CONTROL_BUSY' }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    try { return action(); } finally { const current = read(this.files.guard, null); if (current?.token === token && current.pid === process.pid) fs.unlinkSync(this.files.guard); }
  }
  worker() {
    const worker = read(this.files.lock, null);
    if (!worker) return null;
    if (worker.version !== 1 || typeof worker.runId !== 'string' || typeof worker.sessionId !== 'string' || !['api', 'dsh'].includes(worker.source) || !Number.isSafeInteger(worker.pid)) throw new Error('自主观看锁格式无效，请核对原记录。');
    return { ...worker, alive: alive(worker.pid), owned: worker.runId === this.runId && worker.pid === process.pid };
  }
  budget() {
    const value = read(this.files.budget, { version: 1, sessions: {}, days: {} });
    if (!value || value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) || !value.days || typeof value.days !== 'object' || Array.isArray(value.days) || Object.values(value.sessions).some(item => !item || !Number.isSafeInteger(item.requests) || item.requests < 0) || Object.values(value.days).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('自主观看预算损坏，未重新计数。');
    return value;
  }
  state() {
    const worker = this.worker(), saved = read(this.files.state, {}), time = this.videoLimits.state();
    const historicalSession = typeof saved.sessionId === 'string' && saved.sessionId ? saved.sessionId : null;
    const sessionId = worker?.sessionId || historicalSession || time.session?.id || null;
    const savedMatches = worker ? saved.runId === worker.runId && saved.sessionId === worker.sessionId && saved.source === worker.source : Boolean(historicalSession && saved.sessionId === sessionId);
    const selectedSaved = savedMatches ? saved : {};
    const budget = this.budget(), counts = budget.sessions[sessionId] || { requests: 0 };
    const request = read(this.files.stop, null), stopping = worker?.alive && request?.runId === worker.runId;
    const savedRunMatches = savedMatches && worker?.alive && Number.isFinite(worker.heartbeatAt) && this.now() - worker.heartbeatAt >= 0 && this.now() - worker.heartbeatAt < 5000;
    const ownRun = this.running && worker?.owned && worker.sessionId === this.sessionId && worker.source === this.source;
    return redact({ protocol: 'autonomous-watch-v1', running: Boolean(worker?.alive), owned: Boolean(worker?.owned), worker, status: stopping ? 'stopping' : worker?.alive ? 'running' : ['running', 'stopping'].includes(selectedSaved.status) ? 'stopped' : selectedSaved.status || 'stopped', sessionId, counts: { ...counts, maxRequests:null, dailyRequests: time.daily?.requests ?? budget.days[day(this.now())] ?? 0, dailyLimit: time.policy.dailyRequests ?? null }, phase: ownRun ? this.phase || 'waiting' : savedRunMatches ? selectedSaved.phase || 'waiting' : 'idle', pendingRequests: ownRun ? this.pendingRequests || 0 : savedRunMatches && selectedSaved.pendingRequests === 1 ? 1 : 0, shareProgress: ownRun ? this.shareProgress || null : savedRunMatches ? readShareProgress(selectedSaved.shareProgress) : null, options: this.optionsService.state().policy, lastDecision: selectedSaved.lastDecision || null, lastError: selectedSaved.lastError || '', lastSwitchDiagnostic: readSwitchDiagnostic(selectedSaved.lastSwitchDiagnostic), remainingSeconds: time.allowed && time.session?.id === sessionId ? time.remainingSeconds : 0 }, [this.config.apiKey]);
  }
  // 落盘是「记录」不是「决策」：写不进去只丢一次状态快照，绝不能因此终止整轮观看。
  // 这个函数在观看循环里每轮被调用五六次，是整条链上最频繁的写，也是之前 EPERM 打死循环的地方。
  save(value) {
    try {
      write(this.files.state, redact({ ...read(this.files.state, {}), ...value, source: this.source, sessionId: this.sessionId, runId:this.runId, updatedAt: new Date(this.now()).toISOString() }, [this.config.apiKey]));
      this.saveFailures = 0;
    } catch (error) {
      this.saveFailures = (this.saveFailures || 0) + 1;
      // 只在第一次和每二十次报告，避免刷屏；继续观看。
      if (this.saveFailures === 1 || this.saveFailures % 20 === 0) {
        try { this.onEvent({ type: 'watch.state-save-skipped', reason: error?.message || String(error), failures: this.saveFailures }); } catch {}
      }
    }
  }
  assertAllowed() {
    this.abort?.signal.throwIfAborted();
    const worker = this.worker(); if (!worker?.owned) throw failure('自主观看已失去运行锁，停止操作。');
    // state() 内部会落盘累计用量。落盘失败是统计问题，不能让观看停摆；
    // 但读取/校验失败（账本损坏）是真的状态不明，仍然要停。
    let time;
    try { time = this.videoLimits.state(); }
    catch (error) {
      if (['EPERM','EBUSY','EACCES','EWRITELOCK'].includes(error.code)) {
        this.onEvent({ type: 'watch.ledger-skipped', reason: error?.message || String(error) });
        return null;
      }
      throw error;
    }
    if ((!time.allowed && !(this.pendingRequests===1 && time.reasonCode==='daily-requests')) || time.session?.id !== this.sessionId || time.session?.status!=='active') throw failure(time.reason || '内部观看运行已结束或改变，原自主观看已停止。', 'limited');
    return time;
  }
  reserveRequest() {
    // 请求计数只是统计，写不进去不影响能不能继续看。
    try {
      return this.control(() => {this.assertAllowed();return this.videoLimits.reserveRequest({sessionId:this.sessionId,source:this.source}).requests;});
    } catch (error) {
      if (['EPERM','EBUSY','EACCES','EWRITELOCK'].includes(error.code)) {
        this.onEvent({ type: 'watch.ledger-skipped', reason: error?.message || String(error) });
        return null;
      }
      throw error;
    }
  }
  claimManual(kind) {
    const token = randomUUID();
    this.control(() => {
      if (this.worker()) throw Object.assign(new Error('请先停止共享自主观看，再执行手动任务。'), { status: 409 });
      const manual = read(this.files.manual, null);
      if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口的手动任务或转发仍在执行。'), { status: 409 });
      write(this.files.manual, { pid: process.pid, token, kind });
    });
    return async () => {
      for (let attempt = 0; ; attempt++) {
        try { return this.control(() => { const manual = read(this.files.manual, null); if (manual?.pid === process.pid && manual.token === token) fs.unlinkSync(this.files.manual); }); }
        catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
      }
    };
  }
  start({ startSession = true, maxRequests: _legacyMaxRequests } = {}, { explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('自主观看只能由用户明确启动。'), { status: 403 });
    if (typeof startSession !== 'boolean') throw Object.assign(new Error('内部启动选项格式无效。'), { status: 400 });
    if (!this.decisionProvider && !this.config.apiKey) throw Object.assign(new Error('请先配置 API Key，再启动自主观看。'), { status: 400 });
    if (this.running || this.completion) throw Object.assign(new Error('当前自主观看正在执行或结束。'), { status: 409 });
    this.optionsService.state();
    read(this.files.state, {});
    this.control(() => {
      const worker = this.worker(); if (worker) throw Object.assign(new Error(worker.alive ? '另一个入口已有自主观看运行。' : '上次自主观看留下运行锁，请先点击停止清理残留。'), { status: 409 });
      const manual = read(this.files.manual, null); if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口正在运行手动任务或转发。'), { status: 409, code: 'WATCH_MANUAL_OCCUPIED' });
      let time = this.videoLimits.state();
      if(!time.allowed&&startSession&&time.reasonCode==='disabled'&&!fs.existsSync(path.join(this.stateDir,'watch-schedule-policy.json')))time=this.videoLimits.markSession(this.source,{explicit:true});
      if (time.allowed && (!time.session || time.session.status!=='active')) time=this.videoLimits.markSession(this.source,{explicit:true});
      if (!time.allowed) throw Object.assign(new Error(time.reason || '请先开启有限视频轮次。'), { status: 409 });
      this.personaMemory.initialize?.({ importLegacy: false });
      this.runId = randomUUID(); this.sessionId = time.session.id;
      write(this.files.lock, { version: 1, pid: process.pid, runId: this.runId, sessionId: this.sessionId, source: this.source, status: 'running', heartbeatAt: this.now() });
    });
    this.abort = new AbortController(); this.running = true; this.playbackClosed=false;this.phase='waiting';this.pendingRequests=0;this.startedDate = day(this.now());
    // 评论独立于观看循环运行。
    // 观看会因为模型超时、换片失败、页面异常等各种原因终止，评论挂在它上面就等于继承所有故障——
    // 之前四轮全都是这个原因：评论一次没触发，因为观看先死了。
    // 现在给评论单独的定时器，只要这一轮还活着就按点发，不关心模型和换片结果。
    try { this.startCommentTimer(); }
    catch (error) {
      // 定时器起不来不该让整轮起不来：清掉已写入的锁和会话，把错误原样抛出。
      this.running = false;
      try { this.control(() => { if (this.worker()?.runId === this.runId) fs.unlinkSync(this.files.lock); }); } catch {}
      throw error;
    }
    try {
    this.save({ status: 'running', phase:'waiting',pendingRequests:0,lastError: '', lastDecision: null });
    this.heartbeat = setInterval(() => {
      try {
        const request = read(this.files.stop, null); if (request?.runId === this.runId) this.abort.abort(failure('用户停止自主观看。', 'stopped'));
        this.assertAllowed();
        if(!this.playbackChecking&&typeof this.controller.state==='function'){this.playbackChecking=true;void Promise.resolve(this.controller.state({record:false})).then(state=>{if(this.running&&!this.playbackClosed)this.videoLimits.notePlayback?.(this.source,state,{ownerId:this.runId});}).catch(()=>{}).finally(()=>{this.playbackChecking=false;});}
        this.control(() => { const worker = this.worker(); if (!worker?.owned) throw failure('自主观看锁已改变。'); write(this.files.lock, { ...worker, heartbeatAt: this.now() }); });
      } catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY') this.abort.abort(error); }
    }, 500); this.heartbeat.unref?.();
    // 心跳持续核对最新时段和截止时间，支持不限时长及超过定时器范围的长轮次。
    this.completion = Promise.resolve().then(() => this.run()).catch(error => { this.onEvent({ type: 'watch.failed', message: redact(error.message || String(error), [this.config.apiKey]) }); return { running: false, status: 'failed' }; }).finally(() => { this.completion = null; });
    return this.state();
    } catch (error) {
      clearInterval(this.heartbeat); clearTimeout(this.deadline); this.running = false;
      this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); this.runId = null;
      throw error;
    }
  }
  recordSwitchFailure(name, output, {error,startedAt=this.now(),expectedVideoId,stage}={}) {
    if (!['douyin_next','douyin_previous'].includes(name)) return;
    try {
      if (!this.worker()?.owned) return;
      this.save({lastSwitchDiagnostic:switchFailureDiagnostic({name,output,error,source:this.source,runId:this.runId,now:this.now(),startedAt,expectedVideoId,stage})});
    } catch { try { this.onEvent({type:'watch.diagnostic_failed',message:'换片诊断未能保存。'}); } catch {} }
  }
  async execute(name, args = {}, { expectedVideoId } = {}) {
    this.assertAllowed();
    const startedAt = this.now();
    let output;
    try { output = await this.controller.execute(name, args, { signal: this.abort.signal, autonomousRunId: this.runId, ...(expectedVideoId === undefined ? {} : { expectedVideoId }) }); }
    catch (error) { this.recordSwitchFailure(name,null,{error,startedAt,expectedVideoId}); throw error; }
    if (output?.changed !== true) this.recordSwitchFailure(name,output,{startedAt,expectedVideoId});
    this.assertAllowed();
    const state = output?.state || output;
    // 账本写不进去是「统计丢了」，不是「该停止观看」。原来这里不捕获，
    // 一次 EPERM 就能把整轮观看打死——评论、点赞全都跟着没机会跑。
    try { this.videoLimits.notePlayback?.(this.source,state,{ownerId:this.runId}); }
    catch (error) { this.onEvent({ type: 'watch.ledger-skipped', reason: error?.message || String(error) }); }
    if (state?.loginRequired || state?.verificationRequired || state?.blocked || state?.privateChatVisible || state?.unsupportedPage) throw failure('抖音页面需要手动处理，已停止自主观看。', 'needs_user');
    this.onEvent(redact({ type: 'watch.tool', tool: name, result: output }, [this.config.apiKey]));
    return output;
  }
  async readyAfterModel(current) {
    const deadline = this.now() + 4000;
    for (let attempt = 0; ; attempt++) {
      this.assertAllowed();
      const state = current.state || current;
      let origin; try { origin = new URL(state.url).origin; } catch { /* 暂缺页面资料只作有界回读，不据此输入。 */ }
      if (origin && origin !== 'https://www.douyin.com') throw failure('模型等待后已离开抖音，未执行旧决策。', 'needs_user');
      if (state.video?.paused === true) throw failure('模型等待后播放已暂停，未继续执行旧决策。', 'needs_user');
      if (attempt > 0 && this.now() > deadline) throw failure('模型等待后的作品状态仍未稳定，已停止自主观看。', 'needs_user');
      if (readyVideo(state) && state.video.paused === false) return current;
      if (attempt >= 16 || this.now() >= deadline) throw failure('模型等待后的作品状态仍未稳定，已停止自主观看。', 'needs_user');
      await this.delayImpl(Math.min(250, deadline - this.now()), this.abort.signal); this.assertAllowed();
      current = await this.execute('douyin_status');
    }
  }
  cancel(reason = failure('自主观看已取消。', 'stopped')) { if (this.worker()?.owned) this.abort?.abort(reason); }
  getShareService() {
    if (!this.shareService && this.personaMemory.snapshot) { this.shareService = new AutonomousShare({ controller: this.controller, videoLimits: this.videoLimits, personaMemory: this.personaMemory, stateDir: this.stateDir, source: this.source, now: this.now }); this.ownsShareService = true; }
    return this.shareService;
  }
  shareContext(videoId) { return this.getShareService()?.context({ videoId }) ?? { enabled: false, paused: false, dailyRemaining: 0, recipients: [] }; }
  async recoverDecision(error) {
    if (!['WATCH_DECISION_FORMAT','WATCH_DECISION_INCOMPLETE'].includes(error?.code)) throw error;
    this.invalidDecisionStreak = (this.invalidDecisionStreak || 0) + 1;
    this.onEvent({ type:'watch.decision-rejected', code:error.code, consecutive:this.invalidDecisionStreak, message:'本次模型决策无效，未执行动作。' });
    this.save({ lastDecision:null, decisionRetry:{ consecutive:this.invalidDecisionStreak, code:error.code } });
    if (this.invalidDecisionStreak >= 3) throw failure('连续三次未取得有效观看决策，已停止本次观看；今日用量保留。');
    this.assertAllowed();
    await this.delayImpl(1000,this.abort.signal);
    this.assertAllowed();
    return this.execute('douyin_status');
  }
  async shareDecision(decision, { evidenceId, videoId }) {
    const recipients = decision.recipientIds ?? [decision.recipientId];
    const progress = { total:recipients.length, currentIndex:0, completed:0, confirmed:0, notSent:0, skipped:0, status:'sharing' };
    let learned = false;
    const save = () => { this.phase='sharing'; this.shareProgress={...progress}; this.save({phase:this.phase,shareProgress:this.shareProgress,pendingRequests:0}); };
    save();
    for (const [index, recipientId] of recipients.entries()) {
      this.assertAllowed();
      const available = this.shareContext(videoId);
      if (!available.enabled || available.paused) { progress.status='paused'; break; }
      progress.currentIndex=index+1;save();
      if (!available.recipients.some(item=>item.id===recipientId)) { progress.skipped++;progress.completed++;save();continue; }
      const delivery = await this.getShareService().share({evidenceId,videoId,recipientId,reason:decision.reason},{signal:this.abort.signal,watchRunId:this.runId});
      this.onEvent(redact({type:'watch.share',delivery},[this.config.apiKey]));
      if (delivery?.skipped !== undefined || delivery?.status==='skipped' || delivery?.code==='SHARE_ALREADY_PROCESSED') {
        if (delivery.status!=='skipped'||delivery.code!=='SHARE_ALREADY_PROCESSED'||delivery.skipped!==true||delivery.confirmed!==false||delivery.deliveryUncertain!==false||delivery.videoId!==videoId||delivery.recipientId!==recipientId||!['confirmed','not-sent','resolved-confirmed','resolved-not-sent'].includes(delivery.previousStatus)) throw failure('分享跳过回执与当前作品、许可会话或处理状态不一致，已停止自主观看。','needs_user');
        progress.skipped++;
        this.onEvent({type:'watch.share-skipped',code:delivery.code,videoId,recipientId,previousStatus:delivery.previousStatus,message:'此作品已为该许可会话处理过，跳过重复分享。'});
      } else if (delivery?.code==='SHARE_PREFLIGHT_NOT_SENT'||delivery?.preflight!==undefined) {
        if (delivery.status!=='not-sent'||delivery.code!=='SHARE_PREFLIGHT_NOT_SENT'||delivery.confirmed!==false||delivery.deliveryUncertain!==false||delivery.deliveryType!=='native-card'||typeof delivery.operationId!=='string'||!delivery.operationId||delivery.videoId!==videoId||delivery.recipientId!==recipientId||!isSharePreflightNotSent(delivery,{videoId,recipientId})) throw failure('分享准备失败回执不能证明尚未发送，已停止自主观看。','needs_user');
        progress.notSent++;
        this.onEvent({type:'watch.share-not-sent',code:delivery.code,failureCode:delivery.failure.code,stage:delivery.failure.stage,operationId:delivery.operationId,videoId,recipientId,message:'本次确定未发送，跳过该对象，继续处理其余对象和观看。'});
      } else if (delivery?.deliveryUncertain) {
        if(delivery.confirmed!==false||delivery.deliveryType!=='native-card'||delivery.videoId!==videoId||delivery.recipientId!==recipientId||typeof delivery.operationId!=='string'||!delivery.operationId)throw failure('分享回执身份不完整，已停止自主观看。','needs_user');
        progress.completed++;progress.status='paused';save();
        this.onEvent({type:'watch.share-paused',code:'SHARE_DELIVERY_UNCERTAIN',message:'保留未确认的分享记录，暂停后续分享，不重发；继续观看。'});
        break;
      } else if (delivery?.confirmed===true&&delivery.deliveryType==='native-card'&&delivery.videoId===videoId&&delivery.recipientId===recipientId&&typeof delivery.operationId==='string'&&delivery.operationId&&typeof delivery.messageId==='string'&&delivery.messageId) {
        progress.confirmed++;
        learned=this.behavior(evidenceId,'share',delivery.operationId)?.accepted===true||learned;
      } else if(delivery?.confirmed===true) throw failure('分享收据缺少可核对的同作品与好友身份，已停止自主观看。','needs_user');
      progress.completed++;save();
      // 每人结束都会释放共同发送锁，短暂让出执行机会，避免连续分享挤占好友回复。
      if(index+1<recipients.length)await this.delayImpl(200,this.abort.signal);
    }
    if(progress.status==='sharing')progress.status='completed';
    this.phase='waiting';this.shareProgress={...progress};this.save({phase:this.phase,shareProgress:this.shareProgress,pendingRequests:0});
    return learned;
  }
  getCommentService() {
    if (!this.commentService && this.personaMemory.snapshot) { this.commentService = new AutonomousComments({ controller: this.controller, videoLimits: this.videoLimits, personaMemory: this.personaMemory, stateDir: this.stateDir, source: this.source, now: this.now }); this.ownsCommentService = true; }
    return this.commentService;
  }
  commentContext() {
    const context = this.getCommentService()?.context() ?? { enabled: false, paused: false, remainingDaily: 0, remainingSession: 0 };
    // 连续失败后本轮不再给出评论额度，模型不会再选评论，也就不会继续烧请求。
    return this.commentPaused ? { ...context, enabled: false } : context;
  }
  // 评论只是观看的附加动作：可修复的失败记一笔跳过并继续刷；只有结果不明或连续修不好才停。
  // benign=true 的跳过（如同一个作品已有评论记录的防重复拒绝）不是故障：换一个作品就能评，
  // 不该累计进「连续失败」，否则模型长时间 stay 在已评过的视频上会把评论整个暂停掉。
  recordCommentSkip(videoId, reason, benign = false) {
    if (benign) {
      this.onEvent({ type: 'watch.comment-skipped', videoId, reason, benign: true, message: `这个作品不评（${reason}），等下一个作品再试。` });
      return;
    }
    this.commentSkipStreak = (this.commentSkipStreak || 0) + 1;
    this.onEvent({ type: 'watch.comment-skipped', videoId, reason, consecutive: this.commentSkipStreak, message: `这条评论没有发出去（${reason}），已跳过并继续观看。` });
    if (this.commentSkipStreak < COMMENT_LIMITS.maxConsecutiveSkips) return;
    // 连续失败说明当前页面适配有问题：本轮不再尝试评论，观看照常继续，不烧配额。
    this.commentPaused = true;
    this.onEvent({ type: 'watch.comment-paused', reason, message: `评论连续 ${this.commentSkipStreak} 次没有发出去，本轮不再尝试评论；观看继续。` });
  }
  // 读回当前是否在播。取不到就返回 null，让调用方按「未知」处理而不是瞎猜。
  async isPlaying() {
    try {
      const now = await this.execute('douyin_status');
      const paused = (now.state || now).video?.paused;
      return typeof paused === 'boolean' ? !paused : null;
    } catch { return null; }
  }
  // 确保视频在播。这是切换和观看的前提：暂停状态下滚轮切换不生效。
  // 最多试三次，每次读回确认，避免「发了播放命令但没生效」。
  async ensurePlaying({ attempts = 3 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const playing = await this.isPlaying();
      if (playing === true) return true;
      try { await this.execute('douyin_play'); }
      catch (error) { this.onEvent({ type: 'watch.play-failed', attempt: i + 1, reason: error?.message || String(error) }); }
      await this.delayImpl(300 + i * 400, this.abort.signal);
    }
    const final = await this.isPlaying();
    if (final !== true) this.onEvent({ type: 'watch.play-unconfirmed', message: '视频没能恢复播放，后续换片可能失效。' });
    return final === true;
  }
  // 独立的评论定时器：按 config.comment.everySeconds 的节奏自己跑，
  // 不依赖观看循环走到哪一步，也不受模型、换片、超时影响。
  // 首次立即触发一次，之后按间隔。出错只记录，不抛出——它垮了也不能连累观看。
  startCommentTimer() {
    this.stopCommentTimer();
    const everySeconds = this.getAgentConfig().get().comment?.everySeconds ?? 180;
    const tick = async () => {
      if (!this.running || this.abort?.signal.aborted) return;
      if (this.commentTimerBusy) return;
      this.commentTimerBusy = true;
      try {
        // 自己读当前作品，不依赖观看循环的变量。拿不到就等下一拍。
        const now = await this.execute('douyin_status');
        const state = now.state || now;
        const videoId = state.video?.id;
        if (!videoId) return;
        const evidenceId = this.personaMemory.snapshot?.()?.recentObservations?.find(item => item.videoId === videoId)?.id;
        await this.tryTimedComment({ evidenceId, videoId, observedState: state });
      } catch (error) {
        try { this.onEvent({ type: 'watch.comment-timer-error', reason: error?.message || String(error) }); } catch {}
      } finally {
        this.commentTimerBusy = false;
      }
    };
    // 首次立即跑一次（tryTimedComment 自己判断 lastCommentAt，首次会直接评论）。
    void tick();
    this.commentTimer = setInterval(() => { void tick(); }, Math.max(30, Math.min(3600, everySeconds)) * 1000);
    this.commentTimer.unref?.();
    return this.commentTimer;
  }
  stopCommentTimer() {
    if (this.commentTimer) { clearInterval(this.commentTimer); this.commentTimer = null; }
    this.commentTimerBusy = false;
  }
  // 定时评论：唯一条件是「距上次评论够久了」。不看模型意见，不看播放进度，不看作答资格。
  // 评论前暂停视频让输入框稳定；结束后必须恢复播放，否则下一次换片会因暂停而失效。
  async tryTimedComment({ evidenceId, videoId, observedState }) {
    if (this.commentPaused) return null;
    const config = this.getAgentConfig().get();
    if (config.comment?.enabled === false) return null;
    const everySeconds = config.comment?.everySeconds ?? 180;   // 默认三分钟一条
    const lastAt = this.lastCommentAt || 0;
    const waited = (this.now() - lastAt) / 1000;
    if (lastAt && waited < everySeconds) return null;

    let pausedByUs = false;
    try {
      const now = await this.execute('douyin_status');
      if ((now.state || now).video?.id !== videoId) return null;
      if ((now.state || now).video?.paused === false) {
        await this.execute('douyin_pause');
        pausedByUs = true;
        this.onEvent({ type: 'watch.comment-paused-video', videoId, message: '评论前暂停视频。' });
      }
      const delivery = await this.publishTemplatedComment({ evidenceId, videoId, freshState: now.state || now });
      this.lastCommentAt = this.now();
      return delivery;
    } catch (error) {
      // 评论是附加动作，失败只记一笔，绝不中断观看。
      this.onEvent({ type: 'watch.comment-failed', videoId, reason: error?.message || String(error) });
      return null;
    } finally {
      // 不管评论成功、失败还是抛错，只要是我们暂停的，就必须播回去。
      // 没播回去的后果不是「少看几秒」，而是下一次滚轮换片整个失效，整轮观看就此死掉。
      if (pausedByUs) {
        const resumed = await this.ensurePlaying();
        this.onEvent(resumed
          ? { type: 'watch.comment-resumed-video', videoId }
          : { type: 'watch.comment-resume-failed', videoId, message: '评论后没能恢复播放，已多次重试。' });
      }
    }
  }
  // 模板评论：正文本地抽，完全不调用模型，也不做「够不够格」的判定。
  // 时机由程序的定时器决定（watch.commentEverySeconds），这里只负责发出去。
  async publishTemplatedComment({ evidenceId, videoId, freshState }) {
    if (freshState?.video?.id !== videoId) { this.recordCommentSkip(videoId, '评论前作品已变化。', true); return null; }
    const gate = this.getGate();
    if (this.commentPaused) return null;
    let text;
    try { text = gate.pickCommentText(); }
    catch (error) { this.recordCommentSkip(videoId, error.message); return null; }
    const delivery = await this.publishComment({ evidenceId, videoId, text });
    if (delivery) this.safeRecord('comment');
    return delivery;
  }
  // 点赞/收藏：本地闸门决定要不要点，浏览器只负责点一次并核对结果。
  // 失败只记跳过，不影响观看——和评论同一个容错口径。
  async performInteraction(action) {
    const gate = this.getGate();
    const allowed = gate.allowance(action);
    if (!allowed.allowed) {
      this.onEvent({ type: `watch.${action}-deferred`, reason: allowed.reason, waitSeconds: allowed.waitSeconds ?? null });
      return null;
    }
    let result;
    try {
      // 用完整 Page 执行互动：currentVideo() 返回的 Locator 在其隔离执行环境里读不到
      // 视口几何（实测 readInPage 经 Locator evaluate 返回 total:0），导致永远「找不到按钮」。
      // toggleInteraction 自己按视口筛选唯一可见按钮，Page 级别执行即可。
      result = await this.controller.withPage(page => toggleInteraction(page, action), { signal: this.abort.signal, launch: false, create: false });
    } catch (error) {
      // 点击前的读取或点击本身失败都按跳过处理，不中断观看。
      this.onEvent({ type: `watch.${action}-skipped`, reason: error?.message || String(error) });
      return null;
    }
    if (result.changed !== true) {
      this.onEvent({ type: `watch.${action}-skipped`, reason: result.reason, already: result.already === true });
      // 本来就选中了：说明这条之前已经点过，不该再试着点它；记一次额度占用相当于把它划掉。
      if (result.already === true) { this.safeRecord(`${action}:noop`); }
      return null;
    }
    this.safeRecord(action);
    this.onEvent({ type: `watch.${action}`, action, reason: result.reason });
    return result;
  }
  // 互动账本同样是「统计」：写不进去不影响刚才那次点赞/收藏本身已经成功。
  safeRecord(action) {
    try { this.getGate().record(action); }
    catch (error) { this.onEvent({ type: 'watch.ledger-skipped', action, reason: error?.message || String(error) }); }
  }
  // 播放进度占时长的比例；取不到可信值就返回 0，让互动判定拒绝而不是瞎猜。
  watchRatio(state) {
    const video = state?.video;
    const time = Number(video?.time), duration = Number(video?.duration);
    if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return 0;
    return Math.min(1, Math.max(0, time / duration));
  }
  getGate() {
    this.gate ??= new InteractionGate({
      stateDir: this.stateDir,
      clock: this.now,
      getConfig: () => this.getAgentConfig().get(),
    });
    return this.gate;
  }
  getAgentConfig() { this.agentConfig ??= new AgentConfig({ stateDir: this.stateDir }); return this.agentConfig; }
  async publishComment({ evidenceId, videoId, text, usage }) {
    let delivery;
    try {
      // 截图检查关闭时没有画面证据，只按当前作品身份提交；次数上限仍在评论服务内核对。
      const payload = evidenceId === undefined || evidenceId === '' ? { videoId, text } : { evidenceId, videoId, text };
      delivery = await this.getCommentService().comment(payload, { signal: this.abort.signal, watchRunId: this.runId });
    } catch (error) {
      // 停止或时限变化属于观看本身的状态，仍按原样结束本轮。
      this.assertAllowed();
      this.recordCommentSkip(videoId, error?.message || String(error), /同一作品已处理过评论/.test(error?.message || String(error)));
      return null;
    }
    this.onEvent({ type: 'watch.comment', delivery, usage });
    // 无人值守：结果不明不结束整轮，记一笔待核对后继续；代价是同一条可能重复，但停摆在远程更糟。
    if (delivery?.deliveryUncertain || delivery?.confirmed !== true) {
      const reason = delivery?.deliveryUncertain
        ? '已点击但读不到确认结果，已记待核对，继续观看（可能重复，远程无法当场核对）。'
        : delivery?.reason || '没有确认公开评论发布成功。';
      this.recordCommentSkip(videoId, reason);
      return null;
    }
    this.commentSkipStreak = 0;
    return delivery;
  }
  // 无人值守：结果不明不结束整轮，记一笔待核对后继续；代价是同一条可能重复，但停摆在远程更糟。
  viewing(evidenceId, from, to, startedAt, sampleId) {
    if (!this.personaMemory.recordViewing) return null;
    return this.personaMemory.recordViewing({ evidenceId, from: from?.state || from, to: to?.state || to, wallSeconds: (this.now() - startedAt) / 1000, sampleId }, { source: this.source });
  }
  behavior(evidenceId, action, operationId) {
    return this.personaMemory.recordBehavior?.({ evidenceId, action, confirmed: true, sampleId: `watch:${this.runId}:${action}:${randomUUID()}`, ...(operationId ? { operationId } : {}) }, { source: this.source });
  }
  async skipLivePreviews(current) {
    // 只跳过已在当前推荐卡片核实的直播入口，不采样、不调用模型或续开轮次。
    while (isLivePreview(current?.state || current)) {
      if (this.liveSkipStreak >= WATCH_LIMITS.maxLiveSkips) throw failure('连续直播预览超过三张，已停止自主观看，请人工查看推荐页。', 'needs_user');
      this.liveSkipStreak++;
      const previous = current.state || current;
      current = await this.execute('douyin_next');
      const next = current.state || current;
      if (!isLivePreview(next) && !readyVideo(next)) throw failure('跳过直播后没有读到就绪的真实作品，已停止自主观看。', 'needs_user');
      this.onEvent({ type: 'watch.live_skip', attempt: this.liveSkipStreak, changed: isLivePreview(next) ? next.livePreview.roomId !== previous.livePreview.roomId : true });
    }
    return current;
  }
  async run() {
    let status = 'stopped', lastError = '';
    this.liveSkipStreak = 0;this.invalidDecisionStreak=0;this.shareProgress=null;this.commentSkipStreak=0;this.commentPaused=false;this.stayedThisRound=false;this.switchFailStreak=0;
    try { this.getGate().newRound(); } catch { /* 闸门初始化失败不阻断观看。 */ }
    try {
      this.save({shareProgress:null,decisionRetry:null});
      let current = await this.execute('douyin_status');
      // 启动阶段的页面加载也是瞬态：douyin_open 的 settle 等 30 秒还没就绪时重试几次，
      // 不让「推荐流尚未读到就绪视频」杀掉整轮。
      for (let attempt = 0; !(current.state || current).video?.id && !isLivePreview(current.state || current); attempt++) {
        if (attempt >= 4) throw failure('连续多次无法读取到推荐流就绪视频，请人工查看页面。', 'needs_user');
        try { current = await this.execute('douyin_open'); }
        catch (error) { this.onEvent({ type: 'watch.switch-skipped', reasonCode: 'open-not-ready', attempt, message: `推荐流还没就绪（${error.message}），重试。` }); await this.delayImpl(3000 + attempt * 2000, this.abort.signal); }
      }
      const initialOptions = this.optionsService.state().policy;
      if (initialOptions.mode === 'topic') {
        current = await this.execute('douyin_search', { query: initialOptions.topics[0] });
        const first = (current.state || current).searchResults?.find(item => Number.isSafeInteger(item.index) && /^\d{10,30}$/.test(item.id));
        if (!first) throw failure('主题搜索没有可核实的作品结果，请更换主题后重试。', 'needs_user');
        current = await this.execute('douyin_open_video', { index: first.index });
      }
      while (true) {
        this.assertAllowed();
        const options=this.optionsService.state().policy;
        current = await this.skipLivePreviews(current);
        // 循环开头强制确认在播：暂停状态下滑轮换片不生效，会连锁导致 switch-input-unconfirmed。
        if ((current.state || current).video?.paused !== false) { await this.ensurePlaying(); current = await this.execute('douyin_status'); }
        if (isLivePreview(current.state || current)) continue;
        const sampleStartedAt = this.now();
        this.phase='observing';this.save({phase:this.phase,pendingRequests:0});
        let observation = await this.execute('douyin_observe', { seconds: WATCH_LIMITS.sampleSeconds });
        // 换片后页面常处于加载态，采样读不到视频 id（或帧与作品不一致）是正常瞬态，
        // 不该终止整轮：等一下重新采样即可。连续多次采不到才按换片失败处理。
        const observedAt = this.now();
        const observedState = observation.state || observation;
        if (isLivePreview(observedState)) { current = observation; continue; }
        if (!/^\d{10,30}$/.test(observedState?.video?.id || '') || observation.observation?.videoId && observation.observation.videoId !== observedState?.video?.id) {
          this.onEvent({ type: 'watch.switch-skipped', reasonCode: 'sample-not-ready', consecutive: (this.switchFailStreak = (this.switchFailStreak || 0) + 1), message: '作品还在加载，画面没采到，稍等重采。' });
          if (this.switchFailStreak >= WATCH_LIMITS.maxSwitchFailures) throw failure('连续多次无法采样到有效作品画面，已停止自主观看，请人工查看页面。', 'needs_user');
          await this.ensurePlaying();
          await this.delayImpl(2000 + Math.random() * 3000, this.abort.signal);
          continue;
        }
        try { watchDecisionMessages(observation); } catch (error) {
          this.onEvent({ type: 'watch.switch-skipped', reasonCode: 'sample-mismatch', consecutive: (this.switchFailStreak = (this.switchFailStreak || 0) + 1), message: `采样核对没通过（${error.message}），稍等重采。` });
          if (this.switchFailStreak >= WATCH_LIMITS.maxSwitchFailures) throw failure('连续多次采样核对失败，已停止自主观看，请人工查看页面。', 'needs_user');
          await this.ensurePlaying();
          await this.delayImpl(2000 + Math.random() * 3000, this.abort.signal);
          continue;
        }
        this.switchFailStreak = 0;
        this.liveSkipStreak = 0;
        const title = String(observedState.video?.title || '');
        if (options.exclude.some(word => title.toLocaleLowerCase().includes(word.toLocaleLowerCase()))) { current = await this.execute('douyin_next'); continue; }
        const evidenceId = observation.personaEvidenceId || observation.state?.personaEvidenceId || this.personaMemory.recordObservation(observation, { source: this.source, kind: 'visual' }).evidenceId;
        let viewing = observation.viewing;
        // 学习/评论全是「锦上添花」步骤：页面瞬态（换片加载中等）导致校验不过时，
        // 只丢这一步的学习，不终止整轮。它们的 throw 原先落在动作兜底之外，是最后一处杀整轮的路径。
        if (viewing) {
          if (viewing.evidenceId !== evidenceId || viewing.videoId !== observedState.video.id || typeof viewing.sampleId !== 'string' || typeof viewing.accepted !== 'boolean') {
            this.onEvent({ type: 'watch.learning_skipped', message: '观看回执与作品观察不一致，本次没有写入兴趣。' });
            viewing = null;
          }
        } else {
          try { viewing = this.viewing(evidenceId, current, observation, sampleStartedAt, `watch:${this.runId}:observe:${randomUUID()}`); }
          catch (error) {
            if (!['PERSONA_EVIDENCE', 'PERSONA_ARGUMENT'].includes(error.code)) throw error;
            this.onEvent({ type: 'watch.learning_skipped', message: `作品状态暂不可用于学习（${error.message}），本次没有写入兴趣。` });
            viewing = null;
          }
        }
        observation = { ...observation, ...(viewing ? { viewing } : {}) };
        // 定时评论：由程序按时间触发，完全不经过模型，也不看任何「资格」判定。
        // 模型永远倾向选 stay（视频没看完就继续看），指望它主动评论等于永远不评论。
        // 这里只做时间判断：距上一次评论够久了就发一条，然后照常让模型决定怎么看着。
        try { await this.tryTimedComment({ evidenceId, videoId: observedState.video.id, observedState }); }
        catch (error) { this.onEvent({ type: 'watch.comment-error', message: `定时评论这一拍没执行（${error.message}），下拍再试。` }); }
        const shareContext = this.shareContext(observedState.video.id), commentContext = this.commentContext();
        const visualCheck = commentContext.visualCheck !== false;
        const processedRecipients = Array.isArray(shareContext.processedRecipients) ? shareContext.processedRecipients.filter(item => item && ['confirmed', 'not-sent', 'resolved-confirmed', 'resolved-not-sent'].includes(item.status) && shareContext.recipients?.some(recipient => recipient.id === item.recipientId)).map(({ recipientId, status }) => ({ recipientId, status })) : [];
        const context = this.personaMemory.context() + (processedRecipients.length ? '\n\n当前作品分享去重摘要（宿主收据资料，不是聊天正文）：' + JSON.stringify({ videoId: observedState.video.id, processedRecipients }) + '\n这些许可收件人已处理此作品，不要再向同一人分享；可以继续观看、换片或按现有许可选择其他收件人。' : '');
        this.phase='model';this.pendingRequests=1;this.save({phase:this.phase,pendingRequests:1});let result,decisionError;
        try{this.reserveRequest();result=await this.agent.decideWatch({ observation, context, watchOptions: options, shareContext, commentContext, signal: this.abort.signal, decisionProvider: this.decisionProvider, visualCheck });}
        catch(error){if(!['WATCH_DECISION_FORMAT','WATCH_DECISION_INCOMPLETE'].includes(error?.code))throw error;decisionError=error;}
        finally{this.pendingRequests=0;this.phase='waiting';this.save({phase:this.phase,pendingRequests:0});}
        this.assertAllowed();
        if(decisionError){current=await this.recoverDecision(decisionError);continue;}
        let decision;try{decision=redact(parseWatchDecision(result.decision,{shareContext:this.shareContext(),commentContext:this.commentContext()}),[this.config.apiKey]);}catch(error){current=await this.recoverDecision(error);continue;}
        this.invalidDecisionStreak=0;this.save({decisionRetry:null});
        current = await this.execute('douyin_status');
        if (decision.action !== 'stop') current = await this.readyAfterModel(current);
        const freshState = current.state || current, freshAt = this.now(), modelWaitSeconds = (freshAt - observedAt) / 1000;
        if (decision.action !== 'stop' && freshState.video?.id !== observedState.video.id) {
          if (!readyVideo(freshState) || freshState.video.paused !== false) throw failure('模型等待后作品已变化，但新作品尚未就绪或已暂停，未执行旧决策。', 'needs_user');
          this.save({ lastDecision: null, usage: result.usage });
          this.onEvent({ type: 'watch.decision-discarded', action: decision.action, reasonCode: 'observed-video-changed', expectedVideoId: observedState.video.id, currentVideoId: freshState.video.id, message: '作品已变化，放弃旧画面的决策并重新观察当前作品。' });
          continue;
        }
        let gapTrusted = false, waited = null;
        if (freshState.video?.id === observedState.video.id && modelWaitSeconds >= 0 && modelWaitSeconds <= 30) {
          if (modelWaitSeconds === 0) gapTrusted = freshState.video.time === observedState.video.time && freshState.video.duration === observedState.video.duration && freshState.video.paused === false && observedState.video.paused === false && freshState.video.readyState >= 2;
          else {
            try {
              waited = this.viewing(evidenceId, observation, current, observedAt, `watch:${this.runId}:model-wait:${randomUUID()}`);
              gapTrusted = waited?.accepted === true || waited?.reason === 'stalled' && freshState.video.paused === false && observedState.video.paused === false;
            } catch (error) {
              if (!['PERSONA_EVIDENCE', 'PERSONA_ARGUMENT'].includes(error.code)) throw error;
              this.onEvent({ type: 'watch.learning_skipped', message: '模型等待期间的播放状态不可用于学习，本次没有补记观看或快划偏好。' });
            }
          }
        }
        this.save({ lastDecision: decision, usage: result.usage }); this.onEvent({ type: 'watch.decision', decision, usage: result.usage });
        if (decision.action === 'stop') break;
        let learned = false;
        // 单步执行整体兜底：任何一个动作（换片/搜索/停留/点赞/评论/分享）内部核对失败，
        // 只跳过这一步继续跑，不让个别失败终止整轮。连续 5 步都失败才真正停止。
        try {
        if (decision.action === 'skip') {
          const switchStartedAt = this.now();
          // 换片前必须确认在播：暂停状态下滚轮/点击切换事件不会被页面接收，
          // 表现就是 switch-input-unconfirmed，而那不是模型问题，是页面根本没在播。
          await this.ensurePlaying();
          current = await this.execute('douyin_next', {}, { expectedVideoId: observedState.video.id });
          if (current?.staleObservation || current?.reasonCode === 'observed-video-changed') {
            const latest = current.state;
            if (current.changed !== false || current.staleObservation !== true || current.reasonCode !== 'observed-video-changed' || current.expectedVideoId !== observedState.video.id || !readyVideo(latest) || latest.video.id === observedState.video.id || latest.video.paused !== false) throw failure('换片前作品变化的回执无法核对，未继续操作或学习。', 'needs_user');
            this.onEvent({ type: 'watch.decision-discarded', action: 'skip', reasonCode: 'observed-video-changed', expectedVideoId: observedState.video.id, currentVideoId: latest.video.id, message: '输入前作品已变化，未执行换片，重新观察当前作品。' });
            continue;
          }
          current = await this.skipLivePreviews(current);
          if (current.changed === false || !readyVideo(current.state || current) || (current.state || current).video.id === observedState.video.id) {
            const reasonCode = current.reasonCode || (!readyVideo(current.state || current) ? 'autonomous-switch-not-ready' : (current.state || current).video.id === observedState.video.id ? 'autonomous-switch-same-id' : 'autonomous-switch-changed-false');
            this.recordSwitchFailure('douyin_next',{...current,before:current.before||observedState.video,reasonCode},{startedAt:switchStartedAt,expectedVideoId:observedState.video.id,stage:'autonomous-verification'});
            // 换片失败不该杀死整轮：无人值守时停摆比多看一眼同一条更糟。
            // 连续失败太多才停，避免在原地打转烧请求。
            this.switchFailStreak = (this.switchFailStreak || 0) + 1;
            this.onEvent({ type: 'watch.switch-skipped', reasonCode, consecutive: this.switchFailStreak, message: `这次换片没成功（${reasonCode}），继续看当前这条。` });
            if (this.switchFailStreak >= WATCH_LIMITS.maxSwitchFailures) throw failure('连续多次无法切换作品，已停止自主观看，请人工查看页面。', 'needs_user');
            // 确保当前这条还在播，然后重新观察。换片失败最常见的原因就是没在播。
            await this.ensurePlaying();
            await this.delayImpl(2000 + Math.random() * 3000, this.abort.signal);
            continue;
          }
          this.switchFailStreak = 0;
          if (gapTrusted && (viewing?.accepted === true || waited?.accepted === true)) learned = this.behavior(evidenceId, 'skip')?.accepted === true;
        } else if (decision.action === 'search') {
          // 搜索换片和滚轮换片一样不致命：页面加载慢/结果点不开就跳过这轮，别杀死整轮。
          let found = null;
          try {
            found = await this.execute('douyin_search', { query: decision.query });
          } catch (error) {
            this.onEvent({ type: 'watch.switch-skipped', reasonCode: 'search-not-ready', consecutive: (this.switchFailStreak = (this.switchFailStreak || 0) + 1), message: `搜索没完成（${error.message}），继续看当前这条。` });
            if (this.switchFailStreak >= WATCH_LIMITS.maxSwitchFailures) throw failure('连续多次搜索/切换失败，已停止自主观看，请人工查看页面。', 'needs_user');
            await this.ensurePlaying();
            await this.delayImpl(2000 + Math.random() * 3000, this.abort.signal);
            continue;
          }
          const first = (found.state || found).searchResults?.find(item => Number.isSafeInteger(item.index) && item.index >= 0);
          if (!first) {
            this.onEvent({ type: 'watch.switch-skipped', reasonCode: 'search-no-results', consecutive: (this.switchFailStreak = (this.switchFailStreak || 0) + 1), message: '搜索没有返回可核对的作品，继续看当前这条。' });
            if (this.switchFailStreak >= WATCH_LIMITS.maxSwitchFailures) throw failure('连续多次搜索/切换失败，已停止自主观看，请人工查看页面。', 'needs_user');
            await this.ensurePlaying();
            await this.delayImpl(2000 + Math.random() * 3000, this.abort.signal);
            continue;
          }
          try {
            current = await this.execute('douyin_open_video', { index: first.index });
          } catch (error) {
            // open_video 失败（目标作品未加载完成等）：回推荐流继续，不终止整轮。
            this.onEvent({ type: 'watch.switch-skipped', reasonCode: 'search-open-failed', consecutive: (this.switchFailStreak = (this.switchFailStreak || 0) + 1), message: `打开搜索结果没成功（${error.message}），继续看当前这条。` });
            if (this.switchFailStreak >= WATCH_LIMITS.maxSwitchFailures) throw failure('连续多次搜索/切换失败，已停止自主观看，请人工查看页面。', 'needs_user');
            await this.ensurePlaying();
            await this.delayImpl(2000 + Math.random() * 3000, this.abort.signal);
            continue;
          }
          this.switchFailStreak = 0;
        } else if (decision.action === 'comment') {
          // 正文不再调模型：本地抽模板、过频度闸门，省掉这一整次请求。
          await this.publishTemplatedComment({ evidenceId, videoId: observedState.video.id, observedState, freshState });
        } else if (decision.action === 'like' || decision.action === 'collect') {
          // 点之前再确认作品没换，闸门的额度先不扣，点成了才记账。
          const fresh = await this.execute('douyin_status');
          const freshNow = fresh.state || fresh;
          if (freshNow.video?.id !== observedState.video.id) {
            this.onEvent({ type: 'watch.decision-discarded', action: decision.action, reasonCode: 'observed-video-changed', message: '作品已变化，放弃这次互动。' });
            current = fresh;
            continue;
          }
          await this.performInteraction(decision.action);
          current = fresh;
        } else if (decision.action === 'share') {
          learned=await this.shareDecision(decision,{evidenceId,videoId:observedState.video.id});
        } else if (decision.action === 'stay') {
          const stayBefore = current, beforeState = freshState;
          if (beforeState.video?.id !== observedState.video.id || beforeState.video.paused !== false) throw failure('停留前作品或播放状态已变化，已停止自主观看，没有学习本次停留。', 'needs_user');
          const stayStartedAt = freshAt;
          this.phase='waiting';this.save({phase:this.phase,pendingRequests:0});await this.delayImpl(decision.seconds * 1000, this.abort.signal); this.assertAllowed();
          current = await this.execute('douyin_status');
          const afterState = current.state || current;
          // 只核对「还是同一条」。播放进度当然会前进——长视频上它一直在动，那不是异常。
          // 原来把 paused 一起判，等于在长视频上一选 stay 就必然终止整轮，观看循环直接死掉，评论再没机会执行。
          if (afterState.video?.id !== beforeState.video.id) throw failure('停留期间作品已变化，已停止自主观看，没有学习本次停留。', 'needs_user');
          // 被暂停不是致命错误，恢复播放继续，不结束整轮。用 ensurePlaying 读回确认，不盲发一次命令。
          if (afterState.video?.paused !== false) { await this.ensurePlaying(); current = await this.execute('douyin_status'); }
          const stayed = this.viewing(evidenceId, stayBefore, current, stayStartedAt, `watch:${this.runId}:stay-view:${randomUUID()}`);
          // 停留是这个作品被认真看过的正向证据，留给后续互动判定。
          if (stayed?.accepted === true) { this.stayedThisRound = true; learned = this.behavior(evidenceId, 'stay')?.accepted === true; }
        }
        if (learned && decision.topics.length) this.personaMemory.updateAgentInterests({ evidenceId, topics: decision.topics, reflection: decision.reflection }, { source: this.source });
        if (['share', 'comment'].includes(decision.action)) current = await this.execute('douyin_status');
        } catch (stepError) {
          // 单步兜底：动作内部的核对失败（回执不一致、状态变化等）只丢弃这一步，
          // 恢复播放后重新观察继续跑；连续 5 步失败才停。
          this.switchFailStreak = (this.switchFailStreak || 0) + 1;
          this.onEvent({ type: 'watch.switch-skipped', reasonCode: 'step-failed', consecutive: this.switchFailStreak, message: `这一步没走完（${stepError.message}），跳过继续。` });
          if (this.switchFailStreak >= WATCH_LIMITS.maxSwitchFailures) throw stepError;
          try { await this.ensurePlaying(); current = await this.execute('douyin_status'); } catch {}
          await this.delayImpl(2000 + Math.random() * 3000, this.abort.signal);
          continue;
        }
      }
    } catch (error) {
      const reason = this.abort?.signal.aborted ? this.abort.signal.reason || error : error;
      status = reason.watchStatus || 'failed'; lastError = redact(reason.message || String(reason), [this.config.apiKey]);
    } finally {
      this.playbackClosed=true;this.pendingRequests=0;this.phase='idle';this.stopCommentTimer();clearInterval(this.heartbeat); clearTimeout(this.deadline);
      try{this.videoLimits.settleWatching?.(this.source,{ownerId:this.runId});}catch{}
      try { if (this.worker()?.owned) await this.controller.pauseForLimits?.(); } catch (error) { status = 'failed'; lastError ||= redact(error.message, [this.config.apiKey]); }
      try { for(let attempt=0;;attempt++){try{if(this.worker()?.owned&&this.videoLimits.state().session?.id===this.sessionId)this.videoLimits.endSession?.({explicit:true,reason:'本次自动观看已结束，今日用量继续保留。'});break;}catch(error){if(error.code!=='VIDEO_CONTROL_BUSY'||attempt>=100)throw error;await delay(20);}} } catch(error) {status='failed';lastError ||= redact(error.message,[this.config.apiKey]);}
      try {
        for (let attempt = 0; ; attempt++) {
          try { this.control(() => { const worker = this.worker(); if (worker?.owned) { this.save({ status, lastError,phase:'idle',pendingRequests:0 }); fs.unlinkSync(this.files.lock); const request = read(this.files.stop, null); if (request?.runId === this.runId) fs.unlinkSync(this.files.stop); } }); break; }
          catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
        }
      } catch (error) { status = 'failed'; lastError ||= error.message; }
      this.running = false; if (!this.worker()?.owned) this.runId = null;
      try {
        if (!this.reportService && this.personaMemory.stateFile) this.reportService = new DailyReport({ personaMemory: this.personaMemory, now: this.now });
        for (const date of new Set([this.startedDate || day(this.now()), day(this.now())])) {
          const report = await this.reportService?.generate({ date, reason: 'watch-finished' });
          if (report) this.onEvent({ type: 'watch.report', report: { date: report.date, path: report.path, observedCount: report.observedCount } });
        }
      } catch (error) { this.onEvent({ type: 'watch.report_failed', message: error.message || String(error) }); }
      this.onEvent({ type: `watch.${status}`, message: lastError || '自主观看已停止。' });
    }
    return this.state();
  }
  async stop({ explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('停止共享自主观看需要用户明确操作。'), { status: 403 });
    this.stopCommentTimer();
    const worker = this.worker();
    // stop 必须能把单例从「start 中途抛错」的毒化状态里救回来。
    // 原来 running 只在 run() 的 finally 里重置，而 start() 在 178~201 之间抛错时 run() 根本没启动，
    // 于是 running 永远是 true，后续 start() 全被守卫挡住，只能重启进程。
    if (!this.completion) {
      // run() 从未启动，说明这是一次中途失败的 start：直接收尾，不要 await 一个不存在的 promise。
      this.running = false;
      this.stopCommentTimer();
      if (worker?.owned) this.control(() => { const current = this.worker(); if (current?.runId === worker.runId) fs.unlinkSync(this.files.lock); });
      try { this.save({ status: 'stopped', phase: 'idle', pendingRequests: 0, lastError: '已清理启动失败的残留状态。' }); } catch {}
      return this.state();
    }
    if (worker?.owned) { this.abort?.abort(failure('用户停止自主观看。', 'stopped')); await this.completion; this.running = false; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); }
    else if (worker?.alive) this.control(() => { const current = this.worker(); if (current?.runId === worker.runId) write(this.files.stop, { runId: worker.runId, requestedAt: this.now() }); });
    else if (worker) this.control(() => { if (this.worker()?.runId === worker.runId) { fs.unlinkSync(this.files.lock); write(this.files.state, { status: 'stopped', runId: worker.runId, sessionId: worker.sessionId, source: worker.source, phase: 'idle', pendingRequests: 0, lastError: '已清理退出进程的残留锁，预算继续保留。' }); } });
    return this.state();
  }
  async close() { if (this.worker()?.owned) { this.abort?.abort(failure('本入口已关闭。', 'stopped')); await this.completion; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); } if (this.ownsShareService) await this.shareService.close(); if (this.ownsCommentService) await this.commentService.close(); }
}
