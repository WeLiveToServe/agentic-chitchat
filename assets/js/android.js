(function () {
  const API_BASE_CANDIDATES = window.location.origin.includes("localhost") || window.location.origin.includes("127.0.0.1")
    ? ["http://127.0.0.1:7100", "http://127.0.0.1:7000"]
    : [window.API_BASE_URL || "http://127.0.0.1:7100", "http://127.0.0.1:7000"];
  let cachedApiBase = null;

  const PREFS_KEY = "whisptt.agentPrefs";
  const DEFAULT_PREFS = {
    agentId: "vanilla",
    inputMode: "snippet",
    responseMode: "text_only",
    autoSendVoice: false,
  };

  const ui = {
    threadChip: document.getElementById("android-thread-chip"),
    log: document.getElementById("android-log"),
    placeholder: document.getElementById("android-placeholder"),
    input: document.getElementById("android-input"),
    send: document.getElementById("android-send"),
    status: document.getElementById("android-status"),
    navChat: document.getElementById("nav-chat"),
    navProfile: document.getElementById("nav-profile"),
    navRecorder: document.getElementById("nav-recorder"),
    navEditor: document.getElementById("nav-editor"),
    navAndroid: document.getElementById("nav-android"),
  };

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
    } catch (error) {
      return { ...DEFAULT_PREFS };
    }
  }

  async function api(path, options) {
    const candidates = cachedApiBase ? [cachedApiBase, ...API_BASE_CANDIDATES.filter((base) => base !== cachedApiBase)] : API_BASE_CANDIDATES;
    let lastError = null;
    for (const base of candidates) {
      try {
        const response = await fetch(`${base}${path}`, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.detail || "Request failed");
        }
        cachedApiBase = base;
        return data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Request failed");
  }

  function setStatus(message, tone) {
    ui.status.textContent = message || "";
    ui.status.classList.remove("success", "error");
    if (tone) {
      ui.status.classList.add(tone);
    }
  }

  function renderEntry(role, text) {
    const entry = document.createElement("article");
    entry.className = `android-entry android-entry--${role}`;
    entry.innerHTML = `
      <p class="android-entry__meta">${role === "agent" ? "Local agent" : "You"}</p>
      <p class="android-entry__body"></p>
    `;
    entry.querySelector(".android-entry__body").textContent = text;
    ui.log.appendChild(entry);
    ui.placeholder.style.display = "none";
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  async function loadThreadChip() {
    try {
      const detail = await api("/api/threads/active");
      ui.threadChip.textContent = `${detail.thread.title} // ${detail.snippets.length} snippets`;
    } catch (error) {
      ui.threadChip.textContent = "No active stack";
    }
  }

  async function sendPrompt() {
    const prefs = loadPrefs();
    const text = ui.input.value.trim();
    if (!text) {
      setStatus("Type a prompt first.", "error");
      return;
    }
    ui.send.disabled = true;
    renderEntry("user", text);
    setStatus("Sending to local agent harness...");
    try {
      const result = await api("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: prefs.agentId,
          input_mode: "text",
          text,
          response_mode: prefs.responseMode,
        }),
      });
      renderEntry("agent", result.output_text);
      ui.input.value = "";
      setStatus(`Reply from ${result.agent_id}.`, "success");
      if (result.output_voice_text && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(result.output_voice_text));
      }
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      ui.send.disabled = false;
    }
  }

  function bindNav() {
    ui.navChat.addEventListener("click", () => {
      window.location.href = "html_factory.html";
    });
    ui.navProfile.addEventListener("click", () => {
      window.location.href = "html_profile.html";
    });
    ui.navRecorder.addEventListener("click", () => {
      window.location.href = "html_redline.html";
    });
    ui.navEditor.addEventListener("click", () => {
      window.location.href = "html_editor.html";
    });
    ui.navAndroid.addEventListener("click", () => {
      window.location.href = "html_android.html";
    });
  }

  async function init() {
    bindNav();
    await loadThreadChip();
    ui.send.addEventListener("click", () => {
      sendPrompt();
    });
  }

  init().catch((error) => {
    console.error(error);
    setStatus(error.message || "Failed to load Android link.", "error");
  });
})();
