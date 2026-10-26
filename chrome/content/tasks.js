/* global window, document */
"use strict";
var app;
var selected = new Set();
const labels = { queued: "待提交", submitting: "提交中", waiting: "处理中", downloading: "下载中", done: "已完成", attention: "需处理", stopped: "已停止" };
function element(tag, text) {
  const el = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function renderWorldlib() {
  if (!app) return;
  const state = app.engine.snapshot();
  const visibleIDs = new Set(state.jobs.map(j => j.id));
  selected = new Set([...selected].filter(id => visibleIDs.has(id)));
  const selectAll = document.getElementById("select-all");
  selectAll.checked = !!state.jobs.length && selected.size === state.jobs.length;
  selectAll.indeterminate = selected.size > 0 && selected.size < state.jobs.length;
  document.getElementById("notice").textContent = [app.storageError, app.enqueueMessage, state.notice, state.submissionPaused].filter(Boolean).join(" ");
  document.getElementById("session").textContent = app.getIdentity()
    ? (state.busy ? "正在检查网站结果…" : "已检测到网站登录信息。登录过期时会提示重新扫码。")
    : "尚未登录：点击“扫码登录”，成功后会自动继续处理。";
  document.getElementById("resume").hidden = !state.submissionPaused;
  document.getElementById("empty").hidden = !!state.jobs.length;
  const tbody = document.getElementById("tasks");
  tbody.replaceChildren();
  for (const job of [...state.jobs].reverse()) {
    const tr = element("tr");
    const selection = element("td");
    const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.checked = selected.has(job.id);
    checkbox.setAttribute("aria-label", "选择 " + job.title);
    checkbox.addEventListener("change", () => { checkbox.checked ? selected.add(job.id) : selected.delete(job.id); });
    selection.append(checkbox);
    const description = element("td"); description.append(element("strong", job.title), element("div", job.doi));
    if (job.targets.length > 1) description.append(element("small", "关联 " + job.targets.length + " 条文献"));
    const status = element("td"); const badge = element("span", labels[job.state] || "需处理"); badge.className = "badge " + job.state; status.append(badge);
    const details = element("td", job.error || (job.state === "done" ? "PDF 已添加到原文献。" : ""));
    const done = job.targets.filter(t => t.state === "done").length;
    if (job.targets.length > 1) details.append(element("div", "已完成 " + done + " / " + job.targets.length));
    tr.append(selection, description, status, details); tbody.append(tr);
  }
}
window.addEventListener("load", () => {
  app = window.arguments[0].wrappedJSObject.app;
  const bind = (id, fn) => document.getElementById(id).addEventListener("click", () => app.run(async () => {
    if (app.storageError && !["login", "website"].includes(id)) throw new Error("storage");
    await fn(); renderWorldlib();
  }));
  bind("login", () => app.openLogin());
  bind("website", () => app.openWebsite());
  bind("refresh", () => app.engine.tick(true));
  bind("resume", async () => { await app.engine.resumeSubmissions(); await app.engine.tick(true); });
  bind("retry", async () => { await app.engine.retry([...selected]); await app.engine.tick(true); });
  bind("stop", () => app.engine.stop([...selected]));
  bind("delete", () => app.engine.removeRecords([...selected]));
  bind("clear-completed", () => app.engine.removeRecords([], { completedOnly: true }));
  bind("resubmit", async () => {
    if (!selected.size) return;
    if (!window.confirm("请先在网站核对：重新提交可能产生重复需求并占用额度。\n确定为所选未完成任务重新提交？")) return;
    await app.engine.retry([...selected], { resubmit: true });
    await app.engine.tick(true);
  });
  document.getElementById("select-all").addEventListener("change", event => {
    selected = event.target.checked ? new Set(app.engine.snapshot().jobs.map(j => j.id)) : new Set(); renderWorldlib();
  });
  renderWorldlib();
});
