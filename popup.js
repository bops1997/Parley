// Parley popup — saves settings via background so they persist when popup closes instantly.
const wakeEl = document.getElementById("toggle-wake");
const fieldEl = document.getElementById("toggle-field");
const voiceEl = document.getElementById("toggle-voice");
const statusEl = document.getElementById("status");
const dotEl = document.getElementById("dot");

let saving = false;

function currentSettings() {
  return {
    wakeWord: wakeEl.checked,
    fieldHint: fieldEl.checked,
    voiceMode: voiceEl.checked
  };
}

async function saveAll() {
  if (saving) return;
  saving = true;
  try {
    await chrome.runtime.sendMessage({ type: "PARLEY_SAVE_SETTINGS", settings: currentSettings() });
  } catch (e) {
    console.error("Parley save failed:", e);
  } finally {
    saving = false;
  }
}

async function loadAll() {
  try {
    const s = await chrome.runtime.sendMessage({ type: "PARLEY_GET_SETTINGS" });
    wakeEl.checked = !!s.wakeWord;
    fieldEl.checked = s.fieldHint !== false;
    voiceEl.checked = !!s.voiceMode;
  } catch (e) {
    console.error("Parley load failed:", e);
  }
}

[wakeEl, fieldEl, voiceEl].forEach((el) => {
  el.addEventListener("change", () => { saveAll(); });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveAll();
});
window.addEventListener("pagehide", () => { saveAll(); });

loadAll();

fetch("http://localhost:4141/", { method: "GET" })
  .then(() => { statusEl.textContent = "Backend connected"; })
  .catch(() => {
    dotEl.classList.add("off");
    statusEl.textContent = "Backend not running";
  });
