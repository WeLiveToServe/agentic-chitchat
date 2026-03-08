(function () {
  const API_BASE_CANDIDATES = window.location.origin.includes("localhost") || window.location.origin.includes("127.0.0.1")
    ? ["http://127.0.0.1:7100", "http://127.0.0.1:7000"]
    : [window.API_BASE_URL || "http://127.0.0.1:7100", "http://127.0.0.1:7000"];
  let cachedApiBase = null;

  const PREFS_KEY = "whisptt.agentPrefs";
  const DEFAULT_PREFS = {
    agentId: "gemini_flash",
    inputMode: "snippet",
    responseMode: "text_only",
    autoSendVoice: false,
  };

  const ui = {
    threadChip: document.getElementById("factory-thread-chip"),
    agentChip: document.getElementById("factory-agent-chip"),
    responseChip: document.getElementById("factory-response-chip"),
    grid: document.getElementById("factory-grid"),
    inputMode: document.getElementById("factory-input-mode"),
    responseMode: document.getElementById("factory-response-mode"),
    autoSend: document.getElementById("factory-auto-send"),
    status: document.getElementById("factory-status"),
    openWorkspace: document.getElementById("open-workspace"),
    focusOpenclaw: document.getElementById("focus-openclaw"),
    bannerChat: document.getElementById("banner-chat"),
    bannerMic: document.getElementById("banner-mic"),
    bannerBot: document.getElementById("banner-bot"),
    navChat: document.getElementById("nav-chat"),
    navProfile: document.getElementById("nav-profile"),
    navRecorder: document.getElementById("nav-recorder"),
    navEditor: document.getElementById("nav-editor"),
    navAndroid: document.getElementById("nav-android"),
  };

  let prefs = loadPrefs();
  let options = [];

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
    } catch (error) {
      console.warn("Failed to load prefs", error);
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs() {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }

  async function api(path, optionsArg) {
    const candidates = cachedApiBase ? [cachedApiBase, ...API_BASE_CANDIDATES.filter((base) => base !== cachedApiBase)] : API_BASE_CANDIDATES;
    let lastError = null;
    for (const base of candidates) {
      try {
        const response = await fetch(`${base}${path}`, optionsArg);
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

  function renderCards() {
    ui.grid.innerHTML = "";
    options.forEach((option) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `factory-card${prefs.agentId === option.id ? " factory-card--active" : ""}`;
      card.innerHTML = `
        <p class="factory-card__title">${option.featured ? "Featured // " : ""}${option.name}</p>
        <p class="factory-card__copy">${option.description}</p>
      `;
      card.addEventListener("click", () => {
        prefs.agentId = option.id;
        savePrefs();
        render();
        setStatus(`${option.name} selected for the redline workspace.`, "success");
      });
      ui.grid.appendChild(card);
    });
  }

  function render() {
    renderCards();
    const activeOption = options.find((option) => option.id === prefs.agentId) || { name: "Gemini Flash" };
    ui.agentChip.textContent = `${activeOption.name} selected`;
    ui.responseChip.textContent = prefs.responseMode === "voice_text" ? "Voice + text" : "Text only";
    ui.inputMode.value = prefs.inputMode;
    ui.responseMode.value = prefs.responseMode;
    ui.autoSend.value = prefs.autoSendVoice ? "on" : "off";
    savePrefs();
  }

  async function loadThreadSummary() {
    try {
      const detail = await api("/api/threads/active");
      ui.threadChip.textContent = `${detail.thread.title} // ${detail.snippets.length} snippets`;
    } catch (error) {
      ui.threadChip.textContent = "No active stack";
    }
  }

  async function init() {
    options = await api("/api/agents/options");
    render();
    await loadThreadSummary();

    ui.inputMode.addEventListener("change", () => {
      prefs.inputMode = ui.inputMode.value;
      render();
      setStatus("Send mode saved.", "success");
    });

    ui.responseMode.addEventListener("change", () => {
      prefs.responseMode = ui.responseMode.value;
      render();
      setStatus("Reply mode saved.", "success");
    });

    ui.autoSend.addEventListener("change", () => {
      prefs.autoSendVoice = ui.autoSend.value === "on";
      render();
      setStatus("Voice flow saved.", "success");
    });

    ui.focusOpenclaw.addEventListener("click", () => {
      prefs.agentId = "openclaw";
      render();
      setStatus("OpenClaw moved into the featured slot.", "success");
    });

    ui.openWorkspace.addEventListener("click", () => {
      window.location.href = "html_redline.html";
    });
    if (ui.bannerChat) {
      ui.bannerChat.addEventListener("click", () => {
        window.location.href = "html_chat.html";
      });
    }
    if (ui.bannerMic) {
      ui.bannerMic.addEventListener("click", () => {
        window.location.href = "html_redline.html";
      });
    }
    if (ui.bannerBot) {
      ui.bannerBot.addEventListener("click", () => {
        window.location.href = "html_factory.html";
      });
    }

    ui.navChat.addEventListener("click", () => {
      window.location.href = "html_chat.html";
    });
    ui.navProfile.addEventListener("click", () => {
      window.location.href = "html_profile.html";
    });
    ui.navRecorder.addEventListener("click", () => {
      window.location.href = "html_redline.html";
    });
    ui.navEditor.addEventListener("click", () => {
      window.location.href = "html_redline.html";
    });
    ui.navAndroid.addEventListener("click", () => {
      window.location.href = "html_android.html";
    });

    window.addEventListener("storage", (event) => {
      if (event.key === PREFS_KEY) {
        prefs = loadPrefs();
        render();
      }
    });
  }

  init().catch((error) => {
    console.error(error);
    setStatus(error.message || "Failed to load factory.", "error");
  });
})();
