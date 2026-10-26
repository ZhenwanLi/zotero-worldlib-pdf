/* Pure task and parsing logic, shared by Zotero and Node tests. */
var WorldlibCore = (() => {
  "use strict";
  class TaskError extends Error {
    constructor(code, message) { super(message); this.name = "TaskError"; this.code = code; }
  }
  function normalizeDOI(input) {
    let value = String(input || "").trim();
    try { value = decodeURIComponent(value); } catch (_) { /* Keep literal DOI. */ }
    value = value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i, "").trim();
    return /^10\.\d{4,9}\/[^\s<>"?#]+$/i.test(value) ? value.toLowerCase() : "";
  }
  function extractDOIs(text) {
    return [...new Set((String(text || "").match(/10\.\d{4,9}\/[^\s<>"，。；]+/gi) || [])
      .map(value => normalizeDOI(value.replace(/[.,;]+$/, ""))).filter(Boolean))];
  }
  function parseLinks(value) {
    const list = Array.isArray(value) ? value : String(value || "").split(/[$|\r\n]/);
    return [...new Set(list.map(x => String(x).trim()).filter(x => {
      try { const u = new URL(x); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password; }
      catch (_) { return false; }
    }))];
  }
  function isSafeDownloadURL(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.port
        && ["research.worldlib.site", "reseach1.worldlib.site", "npc1.worldlib.site"].includes(url.hostname);
    } catch (_) { return false; }
  }
  function persistentState(value) {
    const state = copy(value);
    // URLs may carry raw account IDs or signatures. Never serialize them,
    // even while downloading or when saving a legacy task.
    for (const job of state.jobs) job.links = [];
    return state;
  }
  function parseRecord(raw) {
    if (!raw || typeof raw !== "object") throw new TaskError("protocol", "网站返回了无法识别的记录。");
    // User messages contain the DOI too, but are never download results.
    if (raw.msgtype !== undefined && ![2, 12].includes(Number(raw.msgtype))) return null;
    let data = raw;
    if (raw.msgjson !== undefined) {
      if (!raw.msgjson) return null;
      try { data = typeof raw.msgjson === "string" ? JSON.parse(raw.msgjson) : raw.msgjson; }
      catch (_) { throw new TaskError("protocol", "网站历史记录格式发生变化，无法解析。"); }
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new TaskError("protocol", "网站结果格式发生变化。");
    }
    const text = String(data.xuqiuneirong || "");
    const status = String(data.chulizhuangtai || "");
    return {
      id: String(data.articleid ?? data.id ?? raw.id ?? ""),
      messageID: String(raw.id ?? ""), dois: extractDOIs(text), text, status,
      links: parseLinks(data.lianjiedizhi), reason: String(data.failreason || ""),
      failed: /失败|未找到|未查到|无法提供|无结果|已拒绝/.test(status),
      // A link plus an explicit completed state is required; unknown states stay pending.
      complete: /成功|已完成|处理完成/.test(status) && !/未成功|不成功/.test(status),
    };
  }
  function matchRecord(job, records) {
    const matching = records.filter(r => r && r.dois.length === 1 && r.dois[0] === job.doi);
    if (job.remoteIDs.length) {
      const pinned = matching.filter(r => job.remoteIDs.includes(r.id) || job.remoteIDs.includes(r.messageID));
      if (pinned.length) return chooseRecord(pinned);
      if (records.some(r => r && job.remoteIDs.includes(r.id) && r.dois.length && !r.dois.includes(job.doi))) {
        throw new TaskError("mismatch", "网站任务标识与 DOI 不一致，请到网站核对。");
      }
      if (matching.length) throw new TaskError("ambiguous", "历史中的同 DOI 结果属于其他任务，请到网站核对。");
      return null;
    }
    if (!matching.length && records.some(r => r && r.dois.includes(job.doi) && r.dois.length > 1)) {
      throw new TaskError("ambiguous", "网站结果包含多个 DOI，请到网站核对，暂不自动提交或添加附件。");
    }
    return chooseRecord(matching);
  }
  function chooseRecord(records) {
    const unique = new Map();
    for (const r of records) {
      const key = r.id || r.messageID;
      if (!key) throw new TaskError("ambiguous", "网站结果缺少任务标识，请到网站核对。");
      const previous = unique.get(key);
      // History contains multiple snapshots of the same article, newest first.
      // Decimal message IDs preserve that order even above Number.MAX_SAFE_INTEGER.
      const newer = previous && /^\d+$/.test(r.messageID) && /^\d+$/.test(previous.messageID)
        && (r.messageID.length > previous.messageID.length
          || (r.messageID.length === previous.messageID.length && r.messageID > previous.messageID));
      if (!previous || newer) unique.set(key, r);
    }
    if (unique.size > 1) throw new TaskError("ambiguous", "网站有多个同 DOI 的任务，暂不自动选择，请到网站核对。");
    return [...unique.values()][0] || null;
  }
  function isPDF(head, tail, size) {
    // Reject HTML, zero-length files and truncated responses even with a PDF MIME type.
    const prefix = String(head || "").replace(/^\uFEFF/, "").trimStart();
    return size >= 32 && /^%PDF-\d\.\d\b/.test(prefix) && /%%EOF\s*$/.test(String(tail || ""));
  }
  function targetID(target) { return target.libraryID + ":" + target.key; }
  const active = job => ["queued", "submitting", "waiting", "downloading"].includes(job.state);
  const copy = value => JSON.parse(JSON.stringify(value));

  class Engine {
    constructor({ store, site, library, now = () => Date.now(), onChange = () => {} }) {
      Object.assign(this, { store, site, library, now, onChange });
      this.data = { version: 1, jobs: [], submissionPaused: "" };
      this.busy = false; this.closed = false; this.nextCheck = 0; this.failures = 0;
      this.notice = ""; this.saveTail = Promise.resolve(); this.enqueueTail = Promise.resolve();
    }
    async init() {
      const saved = await this.store.load();
      if (saved) {
        if (saved.version !== 1 || !Array.isArray(saved.jobs)) throw new Error("任务文件版本不兼容，未覆盖原文件。");
        for (const job of saved.jobs) {
          if (!normalizeDOI(job.doi) || !Array.isArray(job.targets) || !Array.isArray(job.remoteIDs)) {
            throw new Error("任务文件损坏，未覆盖原文件。");
          }
          if (!Array.isArray(job.links) || !["queued", "submitting", "waiting", "downloading", "done", "attention", "stopped"].includes(job.state)
            || job.targets.some(t => !Number.isInteger(t.libraryID) || !t.key || !["pending", "done", "attention"].includes(t.state))) {
            throw new Error("任务文件损坏，未覆盖原文件。");
          }
          job.doi = normalizeDOI(job.doi);
          job.links = [];
          if (job.state === "submitting") { job.state = "waiting"; job.uncertain = true; }
          if (job.state === "downloading") job.state = "waiting";
        }
        this.data = saved;
      }
      this.emit();
    }
    snapshot() {
      return { ...copy(this.data), jobs: copy(this.data.jobs.filter(j => !j.hidden || active(j))),
        notice: this.notice, busy: this.busy, nextCheck: this.nextCheck };
    }
    emit() { this.onChange(this.snapshot()); }
    async save() {
      const snapshot = persistentState(this.data);
      this.saveTail = this.saveTail.catch(() => {}).then(() => this.store.save(snapshot));
      await this.saveTail;
      this.emit();
    }
    enqueue(items) {
      const operation = this.enqueueTail.catch(() => {}).then(() => this._enqueue(items));
      this.enqueueTail = operation; return operation;
    }
    async _enqueue(items) {
      const summary = { added: 0, joined: 0, existing: 0, noDOI: 0, noPermission: 0, invalid: 0 };
      for (const item of items) {
        if (!item || !item.key) { summary.invalid++; continue; }
        const doi = normalizeDOI(item.doi);
        if (!doi) { summary.noDOI++; continue; }
        const eligibility = await this.library.eligibility(item);
        if (!eligibility.editable) { summary.noPermission++; continue; }
        if (eligibility.hasPDF) { summary.existing++; continue; }
        let job = this.data.jobs.find(j => j.doi === doi && j.state !== "done");
        // Completed jobs retain their result so another item can reuse it without submitting.
        job ||= this.data.jobs.find(j => j.doi === doi && j.state === "done");
        if (!job) {
          const time = this.now();
          job = { id: "wl-" + time + "-" + Math.random().toString(36).slice(2, 10), doi,
            title: item.title || doi, state: "queued", createdAt: time, updatedAt: time,
            targets: [], remoteIDs: [], links: [], account: "", submittedAt: 0, uncertain: false, reason: "", error: "" };
          this.data.jobs.push(job); summary.added++;
        } else summary.joined++;
        job.hidden = false;
        let target = job.targets.find(t => targetID(t) === targetID(item));
        if (!target) {
          target = { libraryID: item.libraryID, key: item.key, state: "pending", error: "" };
          job.targets.push(target);
        } else if (target.state !== "done") { target.state = "pending"; target.error = ""; }
        if (["done", "stopped"].includes(job.state)) job.state = job.submittedAt ? "waiting" : "queued";
      }
      await this.save(); this.nextCheck = 0; return summary;
    }
    async stop(ids) {
      for (const job of this.data.jobs.filter(j => ids.includes(j.id) && j.state !== "done")) {
        job.state = "stopped"; job.updatedAt = this.now(); job.error = "已停止本地处理；网站已收到的需求不会撤回。";
      }
      await this.save();
    }
    removeRecords(ids, { completedOnly = false } = {}) {
      // Serialize with enqueue so a newly selected item cannot disappear while
      // its eligibility check is pending. Keep reconciliation metadata for reuse.
      const operation = this.enqueueTail.catch(() => {}).then(async () => {
        let removed = 0, skipped = 0;
        for (const job of this.data.jobs) {
          if (job.hidden || (completedOnly ? job.state !== "done" : !ids.includes(job.id))) continue;
          if (active(job)) { skipped++; continue; }
          job.hidden = true; removed++;
        }
        this.notice = `已删除 ${removed} 条列表记录，已添加的 PDF 保留。`
          + (skipped ? ` ${skipped} 条正在处理的任务未删除，请先停止。` : "");
        await this.save();
        return { removed, skipped };
      });
      this.enqueueTail = operation; return operation;
    }
    async retry(ids, { resubmit = false } = {}) {
      for (const job of this.data.jobs.filter(j => ids.includes(j.id) && !active(j))) {
        if (job.state === "done") continue;
        if (resubmit) {
          // Only the explicit UI action may clear an uncertain submission.
          job.submittedAt = 0; job.uncertain = false; job.remoteIDs = []; job.links = []; job.account = "";
          job.resubmitRequested = true;
        }
        job.state = job.submittedAt ? "waiting" : "queued";
        job.error = ""; job.reason = "";
        for (const t of job.targets) if (t.state !== "done") { t.state = "pending"; t.error = ""; }
      }
      this.nextCheck = 0; await this.save();
    }
    async resumeSubmissions() { this.data.submissionPaused = ""; this.nextCheck = 0; await this.save(); }
    attention(job, code, message) {
      if (!active(job)) return;
      job.state = "attention"; job.reason = code; job.error = message; job.updatedAt = this.now();
    }
    tick(force = false) {
      if (this.closed || this.busy || (!force && this.now() < this.nextCheck)) return Promise.resolve();
      this.processing = this._tick(force);
      return this.processing;
    }
    async _tick(force = false) {
      if (this.closed || this.busy || (!force && this.now() < this.nextCheck)) return;
      const jobs = this.data.jobs.filter(active);
      if (!jobs.length) return;
      this.busy = true; this.emit();
      try {
        const session = await this.site.session();
        if (this.closed) return;
        for (const job of jobs) {
          if (job.account && job.account !== session.account) {
            this.attention(job, "account_changed", "网站账号已改变，请登录原账号后重试。");
          }
        }
        const pending = jobs.filter(active);
        if (!pending.length) return;
        const history = await this.site.history(session, pending.map(j => ({ doi: j.doi, remoteIDs: j.remoteIDs,
          submittedAt: j.submittedAt })));
        for (const job of pending) {
          if (this.closed) break;
          if (!active(job)) continue;
          try { await this.process(job, session, history); }
          catch (error) {
            if (["login", "network", "protocol", "quota", "permission"].includes(error.code)) throw error;
            this.attention(job, error.code || "failed", error.message || "获取失败，请重试。");
          }
        }
        this.notice = ""; this.failures = 0;
      } catch (error) {
        const code = error.code || "network";
        this.notice = error.message || "网站连接失败，稍后重试。";
        if (["login", "protocol"].includes(code)) {
          for (const j of jobs) this.attention(j, code, this.notice);
        } else if (["quota", "permission"].includes(code)) this.data.submissionPaused = this.notice;
        else this.failures++;
      } finally {
        this.busy = false;
        const young = this.data.jobs.some(j => active(j) && this.now() - (j.submittedAt || j.createdAt) < 300000);
        this.nextCheck = this.now() + Math.min(300000, (young ? 10000 : 60000) * 2 ** Math.min(this.failures, 5));
        await this.save();
      }
    }
    async process(job, session, history) {
      if (job.resubmitRequested) {
        job.ignoredRemoteIDs = [...new Set([...(job.ignoredRemoteIDs || []),
          ...history.records.filter(r => r.dois.includes(job.doi)).flatMap(r => [r.id, r.messageID]).filter(Boolean)])];
      }
      const records = history.records.filter(r => !(job.ignoredRemoteIDs || []).includes(r.id)
        && !(job.ignoredRemoteIDs || []).includes(r.messageID));
      let record = job.resubmitRequested ? null : matchRecord(job, records);
      // Only a freshly queried result may authorize a download. Cached links
      // cannot prove completion or expiry, even within this process.
      job.links = [];
      if (!record && !job.submittedAt && job.remoteIDs.length) {
        throw new TaskError("submit_unknown", "本地已有网站任务标识，暂未查到结果；不会自动重复提交，请到网站核对。");
      }
      if (!record && !job.submittedAt) {
        if (this.data.submissionPaused) return;
        if (!history.complete && !job.resubmitRequested) throw new TaskError("history_incomplete", "历史记录尚未查全，暂不自动提交，请先到网站核对。");
        if (this.site.prepare) await this.site.prepare(session);
        if (this.closed || !active(job)) return;
        // Persist the intent before the HTTP POST: a crash can never cause blind resubmission.
        job.account = session.account;
        job.submittedAt = this.now() || 1; job.state = "submitting"; job.uncertain = true;
        job.resubmitRequested = false;
        await this.save();
        if (this.closed || !active(job)) return;
        try {
          const records = await this.site.submit(session, job.doi);
          if (this.closed || !active(job)) return;
          job.uncertain = false; job.state = "waiting";
          const candidate = matchRecord(job, records);
          if (candidate) {
            record = candidate;
            if (candidate.id) job.remoteIDs = [candidate.id];
            job.ignoredRemoteIDs = (job.ignoredRemoteIDs || []).filter(id => ![candidate.id, candidate.messageID].includes(id));
          }
          await this.save();
        } catch (error) {
          if (this.closed || !active(job)) return;
          if (["quota", "permission", "login"].includes(error.code)) {
            // Explicit rejection means the server did not accept this submission.
            job.submittedAt = 0; job.uncertain = false; job.state = "queued";
            throw error;
          }
          if (active(job)) { job.state = "waiting"; job.error = "提交结果不确定，正在查询历史记录；不会自动再次提交。"; }
          if (error.code === "protocol") throw error;
          throw new TaskError("network", "提交响应未收到，正在核对历史记录，避免重复提交。");
        }
      }
      if (!active(job) || this.closed) return;
      if (!record) {
        if (job.uncertain && this.now() - job.submittedAt >= 300000) {
          this.attention(job, "submit_unknown", history.complete
            ? "提交结果不确定，历史中尚无对应结果。请先到网站核对，再重试查询或明确重新提交。"
            : "提交结果不确定，历史记录尚未查全。请先到网站核对。");
        }
        return;
      }
      job.account ||= session.account;
      job.submittedAt ||= this.now() || 1;
      job.uncertain = false;
      if (record.id && !job.remoteIDs.includes(record.id)) job.remoteIDs.push(record.id);
      job.state = "waiting"; job.updatedAt = this.now();
      if (record.failed) throw new TaskError("remote_failed", record.reason || record.status || "网站处理失败。");
      if (!record.complete) { job.error = record.reason || "网站正在处理。"; return; }
      if (!record.links.length) throw new TaskError("no_link", record.reason || "网站显示已完成，但没有可用下载地址，请到网站核对。");
      job.links = record.links; job.state = "downloading"; job.error = ""; await this.save();
      const stillActive = () => !this.closed && job.state === "downloading";
      for (const target of job.targets) {
        if (!stillActive()) return;
        if (target.state === "done") continue;
        try {
          const result = await this.library.attach(target, job, stillActive);
          if (result?.cancelled) return;
          target.state = "done"; target.attachmentKey = result?.attachmentKey || ""; target.error = "";
        } catch (error) { target.state = "attention"; target.error = error.message; }
        await this.save();
      }
      if (!stillActive()) return;
      if (job.targets.every(t => t.state === "done")) { job.state = "done"; job.error = ""; job.reason = ""; }
      else this.attention(job, "attachment", job.targets.filter(t => t.error).map(t => t.error).join("；"));
    }
    async close() {
      this.closed = true;
      await this.enqueueTail.catch(() => {});
      if (this.processing) await this.processing.catch(() => {});
      await this.saveTail.catch(() => {});
    }
  }
  return { TaskError, normalizeDOI, extractDOIs, parseLinks, isSafeDownloadURL, persistentState, parseRecord, matchRecord, isPDF, Engine, active };
})();
if (typeof module !== "undefined") module.exports = WorldlibCore;
