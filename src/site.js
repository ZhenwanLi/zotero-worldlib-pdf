var WorldlibSite = (() => {
  "use strict";
  const Core = typeof module !== "undefined" ? require("./core.js") : WorldlibCore;
  const BASE = "https://research.worldlib.site";
  const API = "https://reseach1.worldlib.site/tools/submit_ajax.ashx";
  function decodeResponse(body) {
    let result;
    try { result = typeof body === "string" ? JSON.parse(body.replace(/^\uFEFF/, "")) : body; }
    catch (_) {
      if (/login|登录|扫码/i.test(String(body))) throw new Core.TaskError("login", "网站登录已失效，请重新扫码登录。");
      throw new Core.TaskError("protocol", "网站响应不是预期的 JSON，已暂停处理。");
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || result.status === undefined) {
      throw new Core.TaskError("protocol", "网站响应格式发生变化，已暂停处理。");
    }
    if (Number(result.status) !== 0) {
      const message = String(result.msg || result.message || "网站拒绝了请求。");
      let code = "remote";
      if (/登录|扫码|身份.*失效|未认证|会话|login/i.test(message) || Number(result.status) === 10) code = "login";
      else if (/限额|额度|上限|次数|每日.*限|今日.*限/.test(message)) code = "quota";
      else if (/权限|未开通|审核|到期|过期|激活/.test(message)) code = "permission";
      throw new Core.TaskError(code, message);
    }
    return result;
  }
  class Client {
    constructor({ request, getIdentity, fingerprint }) { Object.assign(this, { request, getIdentity, fingerprint }); }
    async session() {
      const identity = this.getIdentity();
      if (!identity || !identity.unionid) throw new Core.TaskError("login", "请先扫码登录，成功后会自动继续处理。");
      return { identity: { ...identity }, account: await this.fingerprint(identity.unionid) };
    }
    async profile(session) {
      const params = new URLSearchParams({ action: "user_getwxid", openid: session.identity.unionid });
      const body = await this.request("GET", BASE + "/tools/submit_ajax.ashx?" + params);
      let profile;
      try { profile = typeof body === "string" ? JSON.parse(body.replace(/^\uFEFF/, "")) : body; }
      catch (_) { throw new Core.TaskError("login", "网站尚未确认登录，请在扫码窗口完成登录。"); }
      // This profile endpoint uses status 1 for a valid account (unlike demand APIs).
      if (!profile || Number(profile.status) !== 1 || !/^[1-9]\d*$/.test(String(profile.userid || ""))) {
        throw new Core.TaskError("login", "网站尚未确认登录，请在扫码窗口完成登录。");
      }
      return profile;
    }
    async confirmLogin() {
      const session = await this.session();
      const profile = await this.profile(session);
      if (profile.usertype === undefined || !Number.isFinite(Number(profile.usertype))) {
        throw new Core.TaskError("login", "网站尚未确认登录，请在扫码窗口完成登录。");
      }
      if (this.getIdentity()?.unionid !== session.identity.unionid) {
        throw new Core.TaskError("login", "登录状态已改变，请等待扫码完成。");
      }
      return session;
    }
    async call(action, session, extra = {}, method = "POST") {
      const current = this.getIdentity();
      if (!current || current.unionid !== session.identity.unionid) {
        throw new Core.TaskError("login", "网站登录状态已改变，请重新登录后继续。");
      }
      const params = new URLSearchParams({ unionid: session.identity.unionid, ...extra });
      const url = API + "?action=" + action + (method === "GET" ? "&" + params : "");
      let response;
      try {
        response = await this.request(method, url, method === "POST" ? params.toString() : undefined);
      } catch (error) {
        if (error instanceof Core.TaskError) throw error;
        throw new Core.TaskError("network", "网站暂时无法连接，将自动延长检查间隔。");
      }
      return decodeResponse(response);
    }
    async results(session, mode = "0") {
      const records = [];
      for (const ishistory of [mode]) {
        if (this.getIdentity()?.unionid !== session.identity.unionid) {
          throw new Core.TaskError("login", "网站登录状态已改变，请重新登录后继续。");
        }
        const params = new URLSearchParams({ uid: session.identity.unionid, keyword: "",
          srctype: "", status: "", bgtime: "", endtime: "", fromsource: "",
          isread: "2", timeorder: "2", ishistory });
        const body = await this.request("POST", BASE + "/tools/submit_ajax.ashx?action=getpersondoc_new", params.toString());
        const text = typeof body === "string" ? body.replace(/^\uFEFF/, "") : body;
        let data;
        if (typeof text === "string" && text.trim() === "") {
          // The site answers an empty 文献管理 list with an empty body; its own page
          // renders that as 暂无数据. Accept the reading only when the account is still
          // recognised, so an unknown or stale uid cannot look like "no records" and
          // unlock a fresh submission.
          let verified = false;
          try { verified = Number((await this.profile(session)).status) === 1; } catch (_) { verified = false; }
          if (!verified) throw new Core.TaskError("protocol", "文献管理结果为空且账号状态无法确认，已暂停处理，避免重复提交。");
          data = [];
        } else {
          try { data = typeof text === "string" ? JSON.parse(text) : text; }
          catch (_) { throw new Core.TaskError("protocol", "文献管理结果不是有效 JSON，已暂停处理，避免重复提交。"); }
        }
        if (!Array.isArray(data)) throw new Core.TaskError("protocol", "文献管理结果格式发生变化，已暂停处理。");
        for (const raw of data) {
          if (!raw || typeof raw !== "object" || !raw.id || typeof raw.title !== "string"
            || typeof raw.status !== "string" || typeof raw.url !== "string") {
            throw new Core.TaskError("protocol", "文献管理记录缺少必要字段，已暂停处理。");
          }
          const links = Core.parseLinks(raw.url).filter(Core.isSafeDownloadURL).map(link => {
            const url = new URL(link);
            if (url.protocol === "https:" && url.hostname === "npc1.worldlib.site") {
              return API + "?" + new URLSearchParams({ action: "getdownfile",
                uid: session.identity.unionid, path: url.pathname + url.search });
            }
            return link;
          });
          const date = /^(\d{4})[\/-](\d{2})[\/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(raw.add_time || ""));
          const added = date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]),
            Number(date[4]), Number(date[5]), Number(date[6])).getTime() : NaN;
          const validDate = date && Number.isFinite(added)
            && new Date(added).getFullYear() === Number(date[1])
            && new Date(added).getMonth() === Number(date[2]) - 1
            && new Date(added).getDate() === Number(date[3])
            && new Date(added).getHours() === Number(date[4])
            && new Date(added).getMinutes() === Number(date[5])
            && new Date(added).getSeconds() === Number(date[6]);
          const expired = !validDate || added > Date.now() || Date.now() - added >= 24 * 3600000;
          records.push({ id: String(raw.id), messageID: "", dois: Core.extractDOIs(raw.title),
            text: raw.title, status: raw.status, links: expired ? [] : links,
            reason: expired && raw.status === "应助完成" ? "网站下载地址已超过 24 小时有效期或日期无法核实，请到网站核对。" : String(raw.replay || ""),
            failed: /失败|未找到|未查到|无法提供|无结果|已拒绝/.test(raw.status),
            complete: raw.status === "应助完成" });
        }
      }
      return records;
    }
    async history(session, jobs = []) {
      // The current result list is authoritative for reuse before submission.
      // An empty HTTP response is not a verified empty list (results rejects it).
      const results = await this.results(session);
      const missingSubmitted = jobs.filter(job => (job.submittedAt || job.remoteIDs.length)
        && !Core.matchRecord(job, results));
      if (missingSubmitted.length) {
        // Only reconcile old submitted jobs on demand. Never reuse unrelated
        // expired historical results for a brand new request.
        try {
          const historical = await this.results(session, "1");
          const ids = new Set(results.map(r => r.id));
          results.push(...historical.filter(r => !ids.has(r.id)
            && missingSubmitted.some(job => r.dois.includes(job.doi))));
        } catch (error) {
          if (!["protocol", "network"].includes(error.code)) throw error;
          return { records: results, complete: false };
        }
      }
      return { records: results, complete: true };
    }
    async messageHistory(session, jobs = []) {
      const records = []; let lastid = ""; const cursors = new Set();
      // Match the website's page size, rather than assuming the server honors a larger value.
      const pageSize = 10;
      for (let page = 0; page < 100; page++) {
        const response = await this.call("getzixunrecordlist", session, { pagesize: pageSize, lastid });
        if (!Array.isArray(response.data)) throw new Core.TaskError("protocol", "网站历史记录缺少 data 数组。");
        for (const raw of response.data) { const r = Core.parseRecord(raw); if (r) records.push(r); }
        if (!response.data.length || response.data.length < pageSize) return { records, complete: true };
        if (jobs.length && jobs.every(job => records.some(r => r.dois.length === 1 && r.dois[0] === job.doi
          && (!job.remoteIDs.length || job.remoteIDs.includes(r.id) || job.remoteIDs.includes(r.messageID))))) {
          return { records, complete: false };
        }
        // The website uses its oldest message as the cursor; IDs are opaque decimal strings.
        const ids = response.data.map(r => String(r.id ?? "")).filter(x => /^\d+$/.test(x));
        if (ids.length !== response.data.length) throw new Core.TaskError("protocol", "历史记录缺少分页标识。");
        ids.sort((a, b) => a.length - b.length || a.localeCompare(b));
        const cursor = ids[0];
        if (cursor === lastid || cursors.has(cursor)) throw new Core.TaskError("protocol", "网站历史分页未前进，已暂停自动处理。");
        cursors.add(cursor); lastid = cursor;
      }
      return { records, complete: false };
    }
    async prepare(session) {
      await this.call("checkP", session, {}, "GET");
      let usertype = Number(session.identity.usertype);
      let remainday = Number(session.identity.remainday);
      if (!Number.isFinite(usertype)) {
        // The site sets usertype/remainday only from its own page script, as session
        // cookies, so they are lost when Zotero restarts. Ask the profile endpoint
        // instead of reporting a permission problem the account does not have.
        const profile = await this.profile(session);
        usertype = Number(profile.usertype); remainday = Number(profile.remainday);
      }
      if (!Number.isFinite(usertype) || usertype < 3 || [4, 16, 20, 512].includes(usertype)) {
        throw new Core.TaskError("permission", "当前网站账号未开通文献咨询或正在审核，请到网站处理。");
      }
      if ([32, 36, 64, 128].includes(usertype) && !(remainday >= 1)) {
        throw new Core.TaskError("permission", "网站身份认证已到期，请到网站重新认证。");
      }
    }
    async submit(session, doi) {
      const result = await this.call("zixun_sendmsg", session, {
        msgcontent: doi
      });
      if (!Array.isArray(result.data)) throw new Core.TaskError("protocol", "网站提交响应格式发生变化，请先核对历史记录。");
      return result.data.map(Core.parseRecord).filter(Boolean);
    }
    async downloadLinks(url, parseDocument) {
      if (!Core.isSafeDownloadURL(url)) {
        throw new Core.TaskError("invalid_pdf", "下载地址不在允许的 HTTPS 主机名单中，请到网站核对。");
      }
      const source = new URL(url);
      // This endpoint returns a landing page, not PDF bytes. Resolve only the
      // observed Worldlib page; never execute its scripts or scrape other HTML.
      if (!["research.worldlib.site", "reseach1.worldlib.site"].includes(source.hostname)
        || source.pathname.toLowerCase() !== "/tools/submit_ajax.ashx"
        || source.searchParams.get("action") !== "getdownfile") return [url];
      const html = await this.request("GET", url);
      if (typeof html !== "string" || html.length > 1024 * 1024) {
        throw new Core.TaskError("invalid_pdf", "世图下载页面格式异常，请到网站核对。");
      }
      const document = parseDocument(html);
      const links = [];
      for (const anchor of document.querySelectorAll("a[href]")) {
        if (anchor.textContent.replace(/\s+/g, "").trim() !== "文件下载") continue;
        try { links.push(new URL(anchor.getAttribute("href"), url).href); }
        catch (_) { /* Invalid links are never passed to the downloader. */ }
      }
      const valid = Core.parseLinks(links).filter(link => link !== url && Core.isLandingDownloadURL(link));
      if (!valid.length) throw new Core.TaskError("invalid_pdf", "世图下载页面未提供有效的“文件下载”链接，请到网站核对。");
      return valid;
    }
  }
  return { Client, decodeResponse, BASE, API };
})();
if (typeof module !== "undefined") module.exports = WorldlibSite;
