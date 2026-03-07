(function () {
  const API_BASE_CANDIDATES = window.location.origin.includes("localhost") || window.location.origin.includes("127.0.0.1")
    ? ["http://127.0.0.1:7100", "http://127.0.0.1:7000"]
    : [window.API_BASE_URL || "http://127.0.0.1:7100", "http://127.0.0.1:7000"];
  let cachedApiBase = null;

  const ui = {
    threadChip: document.getElementById("editor-thread-chip"),
    snippetMeta: document.getElementById("editor-snippet-meta"),
    editor: document.getElementById("transcript-editor"),
    saveSnippet: document.getElementById("save-snippet"),
    addSnippet: document.getElementById("add-snippet"),
    openRedline: document.getElementById("open-redline"),
    status: document.getElementById("editor-status"),
    navChat: document.getElementById("nav-chat"),
    navProfile: document.getElementById("nav-profile"),
    navRecorder: document.getElementById("nav-recorder"),
    navEditor: document.getElementById("nav-editor"),
    navAndroid: document.getElementById("nav-android"),
  };

  const state = {
    activeThread: null,
    activeSnippet: null,
  };

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

  function render() {
    if (!state.activeThread) {
      ui.threadChip.textContent = "No active stack";
      ui.snippetMeta.textContent = "Create or select a stack in redline first.";
      ui.editor.value = "";
      return;
    }
    ui.threadChip.textContent = state.activeThread.thread.title;
    if (state.activeSnippet) {
      ui.snippetMeta.textContent = `Editing snippet #${state.activeSnippet.position} from the active stack.`;
      ui.editor.value = state.activeSnippet.transcript;
    } else {
      ui.snippetMeta.textContent = "No snippet yet. Write text and add it as a new snippet.";
      ui.editor.value = "";
    }
  }

  async function loadActiveThread() {
    const detail = await api("/api/threads/active");
    state.activeThread = detail;
    state.activeSnippet = detail.snippets.length ? detail.snippets[detail.snippets.length - 1] : null;
    render();
  }

  async function saveSnippet() {
    if (!state.activeSnippet) {
      setStatus("No active snippet selected.", "error");
      return;
    }
    const transcript = ui.editor.value.trim();
    if (!transcript) {
      setStatus("Snippet text cannot be empty.", "error");
      return;
    }
    await api(`/api/snippets/${state.activeSnippet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
    });
    await loadActiveThread();
    setStatus("Snippet saved.", "success");
  }

  async function addSnippet() {
    if (!state.activeThread) {
      setStatus("No active thread available.", "error");
      return;
    }
    const transcript = ui.editor.value.trim();
    if (!transcript) {
      setStatus("Write text before adding a new snippet.", "error");
      return;
    }
    await api(`/api/threads/${state.activeThread.thread.id}/snippets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, source: "text" }),
    });
    await loadActiveThread();
    setStatus("New snippet added.", "success");
  }

  function bindNav() {
    ui.openRedline.addEventListener("click", () => {
      window.location.href = "html_redline.html";
    });
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
      window.location.href = "html_editor.html";
    });
    ui.navAndroid.addEventListener("click", () => {
      window.location.href = "html_android.html";
    });
  }

  async function init() {
    bindNav();
    ui.saveSnippet.addEventListener("click", () => {
      saveSnippet().catch((error) => setStatus(error.message, "error"));
    });
    ui.addSnippet.addEventListener("click", () => {
      addSnippet().catch((error) => setStatus(error.message, "error"));
    });
    await loadActiveThread();
  }

  init().catch((error) => {
    console.error(error);
    setStatus(error.message || "Failed to load editor.", "error");
  });
})();
