/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils */
var app;
var chromeHandle;

function install() {}
function uninstall() {}

async function startup({ rootURI, id }) {
  await Zotero.initializationPromise;
  const { classes: Cc, interfaces: Ci } = Components;
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup)
    .registerChrome(manifestURI, [["content", "worldlibpdf", rootURI + "chrome/content/"]]);
  const scope = { Zotero, Services, ChromeUtils, IOUtils, PathUtils,
    setTimeout, clearTimeout, URL, URLSearchParams, TextDecoder, TextEncoder, crypto, XMLHttpRequest, Components };
  for (const file of ["core.js", "site.js", "runtime.js"]) {
    Services.scriptloader.loadSubScript(rootURI + "src/" + file, scope, "UTF-8");
  }
  app = new scope.WorldlibRuntime({ id });
  await app.start();
}

function onMainWindowLoad() {}
function onMainWindowUnload() {}

async function shutdown() {
  if (app) await app.shutdown();
  app = null;
  if (chromeHandle) chromeHandle.destruct();
  chromeHandle = null;
}
