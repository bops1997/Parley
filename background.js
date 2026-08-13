// Parley background — persistent settings + wake-bridge injection (bypasses page CSP).
const STORAGE_KEY = "parleySettings";
const DEFAULTS = { wakeWord: false, fieldHint: true, voiceMode: false, targetLang: "auto" };

async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULTS, ...(data[STORAGE_KEY] || {}) };
}

async function mirrorLegacyKeys(settings) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: settings,
    parleyWakeWord: settings.wakeWord,
    parleyFieldHint: settings.fieldHint,
    parleyVoiceMode: settings.voiceMode,
    parleyTargetLang: settings.targetLang
  });
}

async function saveSettings(partial) {
  const next = { ...(await getSettings()), ...partial };
  await mirrorLegacyKeys(next);
  broadcastSettings();
  if (next.wakeWord) await injectWakeAllTabs();
  return next;
}

function broadcastSettings() {
  chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "PARLEY_SETTINGS_UPDATED" }).catch(() => {});
    }
  });
}

async function injectWakeBridge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["wake-bridge.js"],
      world: "MAIN"
    });
    return true;
  } catch {
    return false;
  }
}

async function injectWakeAllTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(tabs.map((t) => (t.id ? injectWakeBridge(t.id) : Promise.resolve(false))));
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await mirrorLegacyKeys({ ...DEFAULTS });
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  getSettings().then((s) => { if (s.wakeWord) injectWakeBridge(tabId); });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEY] || changes.parleyWakeWord || changes.parleyFieldHint || changes.parleyVoiceMode) {
    broadcastSettings();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PARLEY_GET_SETTINGS") {
    getSettings().then(sendResponse);
    return true;
  }
  if (msg.type === "PARLEY_SAVE_SETTINGS") {
    saveSettings(msg.settings || {}).then(sendResponse);
    return true;
  }
  if (msg.type === "INJECT_WAKE_BRIDGE") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return; }
    injectWakeBridge(tabId).then((ok) => sendResponse({ ok }));
    return true;
  }
});
