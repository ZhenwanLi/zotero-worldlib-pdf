/* global WorldlibCore, WorldlibSite, Zotero, IOUtils, PathUtils, Services */
var WorldlibRuntime = class {
  constructor({ id }) {
    this.id = id; this.windows = new Set(); this.loginWindow = null; this.timer = null;
    this.requests = new Set(); this.stopped = false; this.engine = null; this.enqueueMessage = "";
    this.menuKeys = []; this.loginAttempt = null;
  }
  async start() {
    this.directory = PathUtils.join(Zotero.DataDirectory.dir, "worldlib-pdf");
    await IOUtils.makeDirectory(this.directory, { ignoreExisting: true, createAncestors: true });
    this.statePath = PathUtils.join(this.directory, "tasks.json");
    this.site = new WorldlibSite.Client({
      request: this.request.bind(this), getIdentity: this.getIdentity.bind(this),
      fingerprint: async value => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
        return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
      }
    });
    const store = {
      load: async () => await IOUtils.exists(this.statePath) ? JSON.parse(await IOUtils.readUTF8(this.statePath)) : null,
      save: async state => {
        if (await IOUtils.exists(this.statePath)) {
          const previous = WorldlibCore.persistentState(JSON.parse(await IOUtils.readUTF8(this.statePath)));
          await IOUtils.writeUTF8(this.statePath + ".bak", JSON.stringify(previous, null, 2), {
            tmpPath: this.statePath + ".bak.tmp"
          });
        }
        await IOUtils.writeUTF8(this.statePath, JSON.stringify(state, null, 2), { tmpPath: this.statePath + ".tmp" });
      }
    };
    this.engine = new WorldlibCore.Engine({ store, site: this.site,
      library: { eligibility: this.eligibility.bind(this), attach: this.attach.bind(this) },
      onChange: () => this.render() });
    try { await this.engine.init(); }
    catch (error) {
      this.storageError = "任务记录无法读取。原文件已保留：" + error.message;
      Zotero.logError("[世图 PDF] " + this.storageError);
    }
    await this.run(() => this.restoreLogin());
    this.registerMenus();
    this.schedule();
  }
  registerMenus() {
    const add = (menuID, target, label, command, selection = false) => {
      const registered = Zotero.MenuManager.registerMenu({ menuID, pluginID: this.id, target,
        menus: [{ menuType: "menuitem", icon: "chrome://worldlibpdf/content/icons/menu.svg",
          onShowing: (_event, context) => {
            context.menuElem.setAttribute("label", label);
            if (selection) context.setEnabled(!this.storageError && (context.items || []).some(i => i.isRegularItem()));
          },
          onCommand: (_event, context) => this.run(() => command(context))
        }] });
      if (!registered) throw new Error("Zotero 菜单注册失败：" + target);
      this.menuKeys.push(registered);
    };
    add("worldlib-pdf-fetch", "main/library/item", "通过世图获取 PDF", context => this.enqueue(context.items), true);
    add("worldlib-pdf-tasks", "main/menubar/tools", "世图 PDF 助手：任务与登录", () => this.openTasks());
  }
  async run(action) {
    try { return await action(); }
    catch (error) {
      // Do not include request bodies, cookies, account IDs or signed URLs in errors/logs.
      this.enqueueMessage = error instanceof WorldlibCore.TaskError ? error.message : "操作未完成，请重试；若持续失败，请保留任务文件。";
      this.render();
      Zotero.logError("[世图 PDF] " + (error.code || error.name || "Error"));
    }
  }
  schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.run(() => this.checkLogin());
      if (!this.storageError) await this.run(() => this.engine.tick());
      const identity = this.getIdentity();
      const signature = identity ? [identity.unionid, identity.usertype, identity.remainday].join(":") : "";
      if (signature !== this.identitySignature) { this.identitySignature = signature; this.render(); }
      this.schedule();
    }, 2000);
  }
  getIdentity() {
    const values = {};
    const cookies = Services.cookies.getCookiesFromHost("research.worldlib.site", {});
    for (const cookie of cookies) {
      if (cookie.originAttributes.userContextId || cookie.originAttributes.privateBrowsingId
        || (cookie.expiry && cookie.expiry * 1000 < Date.now() && !cookie.isSession)) continue;
      if (["unionid", "usertype", "remainday"].includes(cookie.name)) {
        try { values[cookie.name] = decodeURIComponent(cookie.value); }
        catch (_) { values[cookie.name] = cookie.value; }
      }
    }
    return values.unionid && !["undefined", "null"].includes(values.unionid) ? values : null;
  }
  persistLogin(session) {
    // The website writes session-only cookies after OAuth. Keep only the three
    // fields used by this adapter in Mozilla's cookie store, never tasks.json.
    if (!session || this.getIdentity()?.unionid !== session.identity.unionid) return;
    const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    for (const cookie of [...Services.cookies.getCookiesFromHost("research.worldlib.site", {})]) {
      if (!cookie.isSession || cookie.originAttributes.userContextId || cookie.originAttributes.privateBrowsingId
        || !["unionid", "usertype", "remainday"].includes(cookie.name)) continue;
      Services.cookies.add(cookie.host, cookie.path, cookie.name, cookie.value,
        cookie.isSecure, cookie.isHttpOnly, false, expiry, cookie.originAttributes,
        cookie.sameSite, cookie.schemeMap);
    }
  }
  async restoreLogin() {
    const identity = this.getIdentity();
    if (!identity) return;
    try {
      const session = await this.site.confirmLogin();
      if (this.stopped) return;
      this.persistLogin(session);
      if (!this.storageError) await this.engine.retry(this.engine.data.jobs
        .filter(j => !j.hidden && j.state === "attention" && j.reason === "login").map(j => j.id));
    } catch (error) {
      // A temporary network failure must not discard a still-valid saved login.
      // Clear rejected cookies only if the user hasn't switched accounts meanwhile.
      if (error.code === "login" && this.getIdentity()?.unionid === identity.unionid) {
        for (const cookie of [...Services.cookies.getCookiesFromHost("research.worldlib.site", {})]) {
          if (!cookie.originAttributes.userContextId && !cookie.originAttributes.privateBrowsingId
            && ["unionid", "usertype", "remainday"].includes(cookie.name)) {
            Services.cookies.remove(cookie.host, cookie.name, cookie.path, cookie.originAttributes);
          }
        }
        throw new WorldlibCore.TaskError("login", "保存的网站登录已失效，请重新扫码登录。");
      }
      throw error;
    }
  }
  async request(method, url, body) {
    // A demand POST must never be transparently retried by Zotero.HTTP's 5xx handler.
    // Native XHR also keeps account parameters out of Zotero's HTTP debug messages.
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest({ mozAnon: false });
      const cancel = () => request.abort();
      request.mozBackgroundRequest = true;
      request.open(method, url, true);
      request.channel.QueryInterface(Components.interfaces.nsIHttpChannelInternal).forceAllowThirdPartyCookie = true;
      request.timeout = 20000;
      // System-principal XHR already uses Zotero's cookie jar; its withCredentials
      // setter is not available in the supported Zotero 9/10 runtime and is not used here.
      request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
      const finish = (callback, value) => { this.requests.delete(cancel); callback(value); };
      request.onload = () => {
        if ([401, 403].includes(request.status)) finish(reject, new WorldlibCore.TaskError("login", "网站登录失效或访问被拒绝，请重新扫码登录。"));
        else if (request.status >= 200 && request.status < 300) finish(resolve, request.responseText);
        else finish(reject, new WorldlibCore.TaskError("network", "网站暂时不可用，稍后重试。"));
      };
      request.onerror = request.ontimeout = request.onabort = () => finish(reject, new WorldlibCore.TaskError("network", "网站连接未完成，稍后重试。"));
      this.requests.add(cancel);
      try { request.send(body ?? null); }
      catch (error) { finish(reject, new WorldlibCore.TaskError("network", "网站连接未完成，稍后重试。")); }
    });
  }
  resolve(target) { return Zotero.Items.getByLibraryAndKeyAsync(target.libraryID, target.key); }
  async eligibility(target) {
    const item = await this.resolve(target);
    if (!item || item.deleted || !item.isRegularItem()) return { editable: false, hasPDF: false };
    const editable = item.isEditable() && Zotero.Libraries.get(item.libraryID).filesEditable;
    let hasPDF = false;
    for (const attachmentID of item.getAttachments()) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (!attachment.deleted && attachment.isPDFAttachment()) { hasPDF = true; break; }
    }
    return { editable, hasPDF };
  }
  async enqueue(items) {
    if (this.storageError) throw new WorldlibCore.TaskError("storage", this.storageError);
    const candidates = (items || []).filter(i => i.isRegularItem()).map(i => ({
      libraryID: i.libraryID, key: i.key, doi: i.getField("DOI"), title: i.getField("title")
    }));
    const s = await this.engine.enqueue(candidates);
    this.enqueueMessage = `新增 ${s.added} 个 DOI 任务，合并 ${s.joined} 条；跳过已有 PDF ${s.existing} 条、无 DOI ${s.noDOI} 条、不可写 ${s.noPermission} 条。`;
    this.render();
    const loginBlocked = () => this.engine.data.jobs.some(j => !j.hidden && j.state === "attention"
      && j.reason === "login" && candidates.some(c => j.targets.some(t => t.libraryID === c.libraryID && t.key === c.key)));
    if (this.engine.data.jobs.some(WorldlibCore.active) || loginBlocked()) {
      if (!this.getIdentity() || loginBlocked()) this.openLogin();
      else {
        await this.engine.tick(true);
        if (loginBlocked()) this.openLogin();
      }
    }
  }
  async attach(target, job, stillActive) {
    let check = await this.eligibility(target);
    if (check.hasPDF) return { attachmentKey: "" };
    if (!check.editable) throw new WorldlibCore.TaskError("readonly", "原文献已删除或文献库不可写。");
    const item = await this.resolve(target);
    if (WorldlibCore.normalizeDOI(item.getField("DOI")) !== job.doi) {
      throw new WorldlibCore.TaskError("mismatch", "原文献的 DOI 已改变，请重新选择文献获取。");
    }
    const temporary = PathUtils.join(PathUtils.tempDir, "worldlib-pdf-" + Services.uuid.generateUUID().toString().replace(/[{}]/g, ""));
    await IOUtils.makeDirectory(temporary);
    const file = PathUtils.join(temporary, "fulltext.pdf");
    try {
      let valid = false;
      for (const url of job.links) {
        if (!stillActive()) return { cancelled: true };
        try {
          const links = await this.site.downloadLinks(url, html => {
            const Parser = Zotero.getMainWindow().DOMParser;
            return new Parser().parseFromString(html, "text/html");
          });
          for (const link of links) {
            if (!stillActive()) return { cancelled: true };
            if (!WorldlibCore.isLandingDownloadURL(link)) continue;
            let cancel;
            try {
              await Zotero.HTTP.download(link, file, {
                timeout: 120000, logBodyLength: 0,
                cancellerReceiver: fn => { cancel = fn; this.requests.add(fn); }
              });
              const stat = await IOUtils.stat(file);
              const head = new TextDecoder("latin1").decode(await IOUtils.read(file, { maxBytes: 1024 }));
              const tail = new TextDecoder("latin1").decode(await IOUtils.read(file, { offset: Math.max(0, stat.size - 4096) }));
              if (!WorldlibCore.isPDF(head, tail, stat.size)) continue;
              valid = true; break;
            } catch (_) { /* Try the next address without logging signed URLs. */ }
            finally { if (cancel) this.requests.delete(cancel); }
          }
          if (valid) break;
        } catch (_) { /* Try the next landing page without logging signed URLs. */ }
      }
      if (!valid) throw new WorldlibCore.TaskError("invalid_pdf", "所有下载地址均失败或返回的文件不是完整 PDF，请到网站核对后重试。");
      if (!stillActive()) return { cancelled: true };
      check = await this.eligibility(target);
      if (check.hasPDF) return { attachmentKey: "" };
      if (!check.editable) throw new WorldlibCore.TaskError("readonly", "原文献已删除或文献库不可写。");
      const freshItem = await this.resolve(target);
      if (WorldlibCore.normalizeDOI(freshItem.getField("DOI")) !== job.doi) {
        throw new WorldlibCore.TaskError("mismatch", "下载期间原文献 DOI 已改变，未添加附件。");
      }
      if (!stillActive()) return { cancelled: true };
      const attachment = await Zotero.Attachments.importFromFile({
        file, parentItemID: freshItem.id, title: "全文 PDF（世图）", contentType: "application/pdf",
        fileBaseName: Zotero.Attachments.getFileBaseNameFromItem(freshItem)
      });
      return { attachmentKey: attachment.key };
    } finally { await IOUtils.remove(temporary, { recursive: true, ignoreAbsent: true }); }
  }
  openTasks() {
    const existing = [...this.windows].find(w => !w.closed);
    if (existing) { existing.focus(); return existing; }
    const window = Services.ww.openWindow(null, "chrome://worldlibpdf/content/tasks.xhtml", "worldlib-pdf-tasks",
      "chrome,centerscreen,resizable,width=1050,height=640", { wrappedJSObject: { app: this } });
    this.windows.add(window);
    // openWindow can unload its initial blank document before the task page
    // loads. That navigation must not drop the live window from our registry.
    window.addEventListener("unload", () => {
      setTimeout(() => { if (window.closed) this.windows.delete(window); }, 0);
    });
    return window;
  }
  openLogin(url = WorldlibSite.BASE + "/login.aspx", { autoClose = true } = {}) {
    if (autoClose && this.loginWindow && !this.loginWindow.closed) {
      // Start on a fresh scanner page, rather than mistaking the old homepage
      // and its pre-existing cookies for a newly completed login.
      this.loginWindow.close(); this.loginWindow = null;
    }
    if (this.loginWindow && !this.loginWindow.closed) {
      const window = this.loginWindow;
      this.loginAttempt = autoClose ? { window, nextCheck: 0 } : null;
      const navigate = () => window.loadURI(Services.io.newURI(url), { allowJavaScript: true });
      if (typeof window.loadURI === "function") navigate();
      else window.addEventListener("load", navigate, { once: true });
      window.focus(); return;
    }
    this.loginWindow = Services.ww.openWindow(null, "chrome://zotero/content/standalone/basicViewer.xhtml", "worldlib-pdf-login",
      "chrome,centerscreen,resizable,width=1060,height=780", { wrappedJSObject: { uri: url, options: { allowJavaScript: true } } });
    this.loginAttempt = autoClose ? { window: this.loginWindow, nextCheck: 0 } : null;
  }
  openWebsite() { this.openLogin(WorldlibSite.BASE + "/", { autoClose: false }); }
  async checkLogin() {
    const attempt = this.loginAttempt;
    if (!attempt) return;
    if (attempt.window.closed) { this.loginAttempt = null; return; }
    if (this.stopped || attempt.checking || Date.now() < attempt.nextCheck || !this.getIdentity()) return;
    const uri = attempt.window.document.querySelector("browser")?.currentURI;
    if (!uri || uri.scheme !== "https" || uri.host !== "research.worldlib.site"
      || !["/", "/index.aspx", "/result_query.aspx"].includes(uri.filePath.toLowerCase())) return;
    attempt.checking = true; attempt.nextCheck = Date.now() + 10000;
    try { await this.continueAfterLogin(attempt); }
    finally { attempt.checking = false; }
  }
  async continueAfterLogin(attempt = this.loginAttempt) {
    const session = await this.site.confirmLogin();
    // The user may have closed the scanner or opened the website while checking.
    if (this.stopped || this.loginAttempt !== attempt || attempt?.window.closed) return;
    this.persistLogin(session);
    if (attempt) {
      this.loginAttempt = null;
      attempt.window.close();
      if (this.loginWindow === attempt.window) this.loginWindow = null;
    }
    this.enqueueMessage = "已登录。任务会自动查询结果并添加 PDF。";
    this.render();
    if (this.storageError) return;
    await this.engine.retry(this.engine.data.jobs.filter(j => !j.hidden && j.state === "attention"
      && ["login", "account_changed"].includes(j.reason)).map(j => j.id));
    await this.engine.tick(true);
  }
  render() {
    for (const window of this.windows) {
      if (!window.closed && typeof window.renderWorldlib === "function") window.renderWorldlib();
    }
  }
  async shutdown() {
    this.stopped = true;
    this.loginAttempt = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.engine) this.engine.closed = true;
    for (const cancel of this.requests) { try { cancel(); } catch (_) {} }
    this.requests.clear();
    for (const window of this.windows) if (!window.closed) window.close();
    if (this.loginWindow && !this.loginWindow.closed) this.loginWindow.close();
    for (const key of this.menuKeys) Zotero.MenuManager.unregisterMenu(key);
    this.menuKeys = [];
    if (this.engine) await this.engine.close();
  }
};
