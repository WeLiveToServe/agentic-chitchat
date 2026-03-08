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

  const state = {
    threads: [],
    activeThread: null,
    activeSnippetId: null,
    agentOptions: [],
    isRecording: false,
    stopInFlight: false,
    prefs: loadPrefs(),
    currentUtterance: null,
    agentSessionId: createSessionId(),
    inlineSnippetRecording: false,
  };

  const ui = {
    threadList: document.getElementById("thread-list"),
    threadCountChip: document.getElementById("thread-count-chip"),
    agentPrefChip: document.getElementById("agent-pref-chip"),
    activeThreadTimer: document.getElementById("active-thread-timer"),
    snippetCountChip: document.getElementById("snippet-count-chip"),
    activeThreadChip: document.getElementById("active-thread-chip"),
    recordingModeChip: document.getElementById("recording-mode-chip"),
    snippetList: document.getElementById("snippet-list"),
    snippetPlaceholder: document.getElementById("snippet-placeholder"),
    activeSnippetChip: document.getElementById("active-snippet-chip"),
    threadTitleInput: document.getElementById("thread-title-input"),
    snippetEditor: document.getElementById("snippet-editor"),
    editorCaretHint: document.getElementById("editor-caret-hint"),
    editorStatus: document.getElementById("editor-status"),
    agentSelect: document.getElementById("agent-select"),
    inputModeSelect: document.getElementById("input-mode-select"),
    responseModeSelect: document.getElementById("response-mode-select"),
    agentInput: document.getElementById("agent-input"),
    agentSendInline: document.getElementById("agent-send-inline"),
    responseModeChip: document.getElementById("response-mode-chip"),
    autoSendToggle: document.getElementById("auto-send-toggle"),
    sendToAgent: document.getElementById("send-to-agent"),
    clearAgentIO: document.getElementById("clear-agent-io"),
    clearAgentOutput: document.getElementById("clear-agent-output"),
    newAgentSession: document.getElementById("new-agent-session"),
    openRelay: document.getElementById("open-relay"),
    agentStatus: document.getElementById("agent-status"),
    agentOutput: document.getElementById("agent-output"),
    micButton: document.getElementById("mic-button"),
    statusText: document.getElementById("status-text"),
    startNewThread: document.getElementById("start-new-thread"),
    startNewThreadInline: document.getElementById("start-new-thread-inline"),
    newSnippetInline: document.getElementById("new-snippet-inline"),
    switchThread: document.getElementById("switch-thread"),
    saveSnippet: document.getElementById("save-snippet"),
    addTextSnippet: document.getElementById("add-text-snippet"),
    saveThreadTitle: document.getElementById("save-thread-title"),
    copyThread: document.getElementById("copy-thread"),
    exportThread: document.getElementById("export-thread"),
    snippetCopyInline: document.getElementById("snippet-copy-inline"),
    snippetDownloadInline: document.getElementById("snippet-download-inline"),
    clearActiveThread: document.getElementById("clear-active-thread"),
    pushSnippetDispatch: document.getElementById("push-snippet-dispatch"),
    pushThreadDispatch: document.getElementById("push-thread-dispatch"),
    syncSettings: document.getElementById("sync-settings"),
    navChat: document.getElementById("nav-chat"),
    navProfile: document.getElementById("nav-profile"),
    navRecorder: document.getElementById("nav-recorder"),
    navEditor: document.getElementById("nav-editor"),
    navAndroid: document.getElementById("nav-android"),
    bannerChat: document.getElementById("banner-chat"),
    bannerMic: document.getElementById("banner-mic"),
    bannerBot: document.getElementById("banner-bot"),
  };

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (!raw) {
        return { ...DEFAULT_PREFS };
      }
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_PREFS, ...(parsed || {}), responseMode: "text_only" };
    } catch (error) {
      console.warn("Failed to load prefs", error);
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs() {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  }

  async function api(path, options) {
    const candidates = cachedApiBase ? [cachedApiBase, ...API_BASE_CANDIDATES.filter((base) => base !== cachedApiBase)] : API_BASE_CANDIDATES;
    let lastError = null;
    for (const base of candidates) {
      try {
        const response = await fetch(`${base}${path}`, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.detail || data.error || "Request failed");
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
    ui.statusText.textContent = message || "";
    ui.statusText.classList.remove("success", "error");
    if (tone) {
      ui.statusText.classList.add(tone);
    }
  }

  function setEditorStatus(message, tone) {
    ui.editorStatus.textContent = message || "";
    ui.editorStatus.classList.remove("success", "error");
    if (tone) {
      ui.editorStatus.classList.add(tone);
    }
  }

  function setAgentStatus(message, toneClass) {
    ui.agentStatus.textContent = message || "";
    ui.agentStatus.className = "agent-status-text";
    if (toneClass) {
      ui.agentStatus.classList.add(toneClass);
    }
  }

  function getActiveSnippet() {
    if (!state.activeThread) {
      return null;
    }
    return state.activeThread.snippets.find((snippet) => snippet.id === state.activeSnippetId) || null;
  }

  function combinedThreadText() {
    if (!state.activeThread) {
      return "";
    }
    return state.activeThread.snippets
      .map((snippet) => snippet.transcript.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "--:--";
    }
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(text) {
    return (text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function compactText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function deriveChatTitle(firstChitText, fallbackTitle) {
    const compact = compactText(firstChitText);
    if (compact) {
      return compact.slice(0, 20);
    }
    return fallbackTitle || "New Chat";
  }

  function renderThreads() {
    ui.threadCountChip.textContent = `${state.threads.length} stack${state.threads.length === 1 ? "" : "s"}`;
    ui.threadList.innerHTML = "";
    state.threads.forEach((thread) => {
      const displayTitle = deriveChatTitle(thread.first_chit_text, thread.title);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `thread-card${thread.is_active ? " thread-card--active" : ""}`;
      button.innerHTML = `
        <p class="thread-card__title">${escapeHtml(displayTitle)}</p>
        <p class="thread-card__meta">${thread.snippet_count} snippet${thread.snippet_count === 1 ? "" : "s"}</p>
        <p class="thread-card__preview">${escapeHtml(thread.latest_snippet_preview || "Waiting for input")}</p>
      `;
      button.addEventListener("click", () => activateThread(thread.id));
      ui.threadList.appendChild(button);
    });
  }

  function renderSnippets() {
    const detail = state.activeThread;
    if (ui.snippetList) {
      ui.snippetList.innerHTML = "";
    }
    const snippets = detail ? detail.snippets : [];
    if (ui.snippetPlaceholder) {
      ui.snippetPlaceholder.style.display = snippets.length ? "none" : "block";
    }
    if (!detail) {
      if (ui.activeThreadChip) {
        ui.activeThreadChip.textContent = "No active stack";
      }
      if (ui.snippetCountChip) {
        ui.snippetCountChip.textContent = "0 snippets";
      }
      if (ui.activeThreadTimer) {
        ui.activeThreadTimer.textContent = "Active Stack";
      }
      return;
    }

    if (ui.activeThreadChip) {
      ui.activeThreadChip.textContent = detail.thread.title;
    }
    if (ui.snippetCountChip) {
      ui.snippetCountChip.textContent = `${detail.snippets.length} snippet${detail.snippets.length === 1 ? "" : "s"}`;
    }
    if (ui.activeThreadTimer) {
      ui.activeThreadTimer.textContent = `Updated ${formatTimestamp(detail.thread.updated_at)}`;
    }

    const orderedSnippets = [...detail.snippets].reverse();
    orderedSnippets.forEach((snippet, index) => {
      if (index > 0) {
        const separator = document.createElement("div");
        separator.className = "snippet-separator";
        separator.textContent = "-------";
        if (ui.snippetList) {
          ui.snippetList.appendChild(separator);
        }
      }
      const card = document.createElement("button");
      card.type = "button";
      card.className = `snippet-card${snippet.id === state.activeSnippetId ? " snippet-card--active" : ""}`;
      card.innerHTML = `
        <p class="snippet-card__text">${escapeHtml(snippet.transcript)}</p>
      `;
      card.addEventListener("click", () => selectSnippet(snippet.id));
      if (ui.snippetList) {
        ui.snippetList.appendChild(card);
      }
    });
  }

  function renderEditor() {
    const detail = state.activeThread;
    const activeSnippet = getActiveSnippet();
    const firstChitText = detail && detail.snippets && detail.snippets.length ? detail.snippets[0].transcript : "";
    ui.threadTitleInput.value = detail ? deriveChatTitle(firstChitText, detail.thread.title) : "";
    if (activeSnippet) {
      if (ui.activeSnippetChip) {
        ui.activeSnippetChip.textContent = `Snippet #${activeSnippet.position}`;
      }
      ui.snippetEditor.value = activeSnippet.transcript;
      if (ui.saveSnippet) {
        ui.saveSnippet.disabled = false;
      }
    } else {
      if (ui.activeSnippetChip) {
        ui.activeSnippetChip.textContent = "No snippet selected";
      }
      ui.snippetEditor.value = "";
      if (ui.saveSnippet) {
        ui.saveSnippet.disabled = true;
      }
    }
    syncEditorCaretHint();
  }

  function syncEditorCaretHint() {
    if (!ui.editorCaretHint || !ui.snippetEditor) {
      return;
    }
    const show = !ui.snippetEditor.value.trim() && !state.isRecording;
    ui.editorCaretHint.classList.toggle("editor-caret-hint--visible", show);
  }

  function renderAgentPrefs() {
    state.prefs.responseMode = "text_only";
    if (state.agentOptions.length) {
      const exists = state.agentOptions.some((option) => option.id === state.prefs.agentId);
      if (!exists) {
        const preferred = state.agentOptions.find((option) => option.id === "gemini_flash");
        state.prefs.agentId = preferred ? preferred.id : state.agentOptions[0].id;
      }
    }
    const selectedOption = state.agentOptions.find((option) => option.id === state.prefs.agentId);
    ui.agentPrefChip.textContent = selectedOption ? selectedOption.name : "Gemini Flash";
    if (ui.recordingModeChip) {
      ui.recordingModeChip.textContent = state.prefs.autoSendVoice ? "Push+Send voice" : "Voice capture";
    }
    if (ui.responseModeChip) {
      ui.responseModeChip.textContent = state.prefs.responseMode === "voice_text" ? "Reply mode: voice + text" : "Reply mode: text only";
    }
    if (ui.autoSendToggle) {
      ui.autoSendToggle.textContent = `Push+Send Voice: ${state.prefs.autoSendVoice ? "On" : "Off"}`;
      ui.autoSendToggle.classList.toggle("pill-button--active", state.prefs.autoSendVoice);
    }

    ui.inputModeSelect.value = state.prefs.inputMode;
    if (ui.responseModeSelect) {
      ui.responseModeSelect.value = state.prefs.responseMode;
    }
    ui.agentSelect.value = state.prefs.agentId;
    savePrefs();
  }

  function createSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function renderAll() {
    renderThreads();
    renderSnippets();
    renderEditor();
    renderAgentPrefs();
  }

  function selectSnippet(snippetId) {
    state.activeSnippetId = snippetId;
    renderSnippets();
    renderEditor();
    setEditorStatus("Editing the active snippet.");
  }

  async function loadThreads() {
    state.threads = await api("/api/threads");
    await Promise.all(
      state.threads.map(async (thread) => {
        try {
          const detail = await api(`/api/threads/${thread.id}`);
          const firstChitText = detail && detail.snippets && detail.snippets.length ? detail.snippets[0].transcript : "";
          thread.first_chit_text = firstChitText || "";
        } catch (error) {
          thread.first_chit_text = "";
        }
      })
    );
  }

  async function loadActiveThread(options) {
    const detail = await api("/api/threads/active");
    state.activeThread = detail;
    if (!detail.snippets.length) {
      state.activeSnippetId = null;
    } else if (options && options.selectSnippetId && detail.snippets.some((snippet) => snippet.id === options.selectSnippetId)) {
      state.activeSnippetId = options.selectSnippetId;
    } else if (!state.activeSnippetId || !(detail.snippets.some((snippet) => snippet.id === state.activeSnippetId))) {
      state.activeSnippetId = detail.snippets[detail.snippets.length - 1].id;
    }
  }

  async function refreshWorkspace(options) {
    await Promise.all([loadThreads(), loadActiveThread(options)]);
    renderAll();
  }

  async function hydrateAgentOptions() {
    state.agentOptions = await api("/api/agents/options");
    ui.agentSelect.innerHTML = "";
    state.agentOptions.forEach((option) => {
      const optionNode = document.createElement("option");
      optionNode.value = option.id;
      optionNode.textContent = option.featured ? `${option.name} // featured` : option.name;
      ui.agentSelect.appendChild(optionNode);
    });
    renderAgentPrefs();
  }

  async function activateThread(threadId) {
    const detail = await api(`/api/threads/${threadId}/activate`, { method: "POST" });
    state.activeThread = detail;
    state.activeSnippetId = detail.snippets.length ? detail.snippets[detail.snippets.length - 1].id : null;
    await loadThreads();
    renderAll();
    setStatus(`Switched to ${detail.thread.title}`, "success");
  }

  async function createThread() {
    const detail = await api("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    state.activeThread = detail;
    state.activeSnippetId = null;
    await loadThreads();
    renderAll();
    ui.snippetEditor.focus();
    setStatus("New snippet stack ready.", "success");
  }

  async function cycleThread() {
    if (!state.threads.length) {
      return;
    }
    const currentIndex = state.threads.findIndex((thread) => thread.is_active);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % state.threads.length : 0;
    await activateThread(state.threads[nextIndex].id);
  }

  async function saveThreadTitle() {
    if (!state.activeThread) {
      return;
    }
    const title = ui.threadTitleInput.value.trim();
    if (!title) {
      setEditorStatus("Thread title cannot be empty.", "error");
      return;
    }
    const updated = await api(`/api/threads/${state.activeThread.thread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    state.activeThread.thread = { ...state.activeThread.thread, ...updated };
    await loadThreads();
    renderAll();
    setEditorStatus("Thread title saved.", "success");
  }

  async function saveSnippetEdit() {
    const snippet = getActiveSnippet();
    if (!snippet) {
      setEditorStatus("Select a snippet before saving.", "error");
      return;
    }
    const transcript = ui.snippetEditor.value.trim();
    if (!transcript) {
      setEditorStatus("Snippet text cannot be empty.", "error");
      return;
    }
    const updated = await api(`/api/snippets/${snippet.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
    });
    await refreshWorkspace({ selectSnippetId: updated.id });
    setEditorStatus("Snippet updated.", "success");
  }

  async function addTextSnippet() {
    if (!state.activeThread) {
      return;
    }
    const transcript = ui.snippetEditor.value.trim();
    if (!transcript) {
      setEditorStatus("Write text in the editor to create a new snippet.", "error");
      return;
    }
    const created = await api(`/api/threads/${state.activeThread.thread.id}/snippets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, source: "text" }),
    });
    await refreshWorkspace({ selectSnippetId: created.id });
    setEditorStatus("New text snippet added to the active stack.", "success");
  }

  async function createSnippetFromInlineAction() {
    const textDraft = ui.snippetEditor.value.trim();
    if (textDraft) {
      await addTextSnippet();
      state.activeSnippetId = null;
      renderSnippets();
      renderEditor();
      ui.snippetEditor.focus();
      setEditorStatus("Snippet saved. Continue with the next snippet.");
      return;
    }
    if (state.isRecording) {
      await stopRecording();
      return;
    }
    state.inlineSnippetRecording = true;
    await startRecording();
    setEditorStatus("Recording started for a new voice snippet.", "success");
  }

  async function ensureSnippetForDispatch() {
    let snippet = getActiveSnippet();
    if (snippet) {
      return snippet;
    }
    if (!state.activeThread) {
      return null;
    }
    const draft = ui.snippetEditor.value.trim();
    if (!draft) {
      return null;
    }
    const created = await api(`/api/threads/${state.activeThread.thread.id}/snippets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: draft, source: "text" }),
    });
    await refreshWorkspace({ selectSnippetId: created.id });
    setEditorStatus("Draft text saved as a new snippet.", "success");
    snippet = getActiveSnippet();
    return snippet || null;
  }

  async function clearActiveThread() {
    if (!state.activeThread) {
      return;
    }
    await api(`/api/transcript/clear?thread_id=${encodeURIComponent(state.activeThread.thread.id)}`, { method: "POST" });
    await refreshWorkspace();
    setStatus("Active thread cleared.", "success");
    setEditorStatus("Thread is empty. Record or add text to continue.");
  }

  async function copyThread() {
    const text = combinedThreadText();
    if (!text) {
      setEditorStatus("Nothing to copy yet.", "error");
      return;
    }
    await navigator.clipboard.writeText(text);
    setEditorStatus("Whole thread copied to clipboard.", "success");
  }

  async function exportThread() {
    if (!state.activeThread) {
      return;
    }
    const result = await api(`/api/session/export?thread_id=${encodeURIComponent(state.activeThread.thread.id)}`, {
      method: "POST",
    });
    let message = `Exported to ${result.export_path}`;
    if (result.combined_transcript && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(result.combined_transcript);
        message += " and copied text.";
      } catch (error) {
        console.warn("Clipboard copy failed", error);
      }
    }
    setEditorStatus(message, "success");
  }

  async function copyEditorText() {
    const text = (ui.snippetEditor.value || "").trim();
    if (!text) {
      setEditorStatus("Nothing to copy.", "error");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      setEditorStatus("Copied current chit text.");
      return;
    }
    ui.snippetEditor.select();
    document.execCommand("copy");
    setEditorStatus("Copied current chit text.");
  }

  function downloadEditorText() {
    const text = (ui.snippetEditor.value || "").trim();
    if (!text) {
      setEditorStatus("Nothing to download.", "error");
      return;
    }
    const title = state.activeThread && state.activeThread.thread && state.activeThread.thread.title
      ? state.activeThread.thread.title
      : "chit";
    const safeTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "chit";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeTitle}-${stamp}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setEditorStatus("Downloaded current chit text.");
  }

  function stopSpeech() {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    state.currentUtterance = null;
  }

  function speakText(text) {
    if (!window.speechSynthesis || !text) {
      return;
    }
    stopSpeech();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 0.92;
    state.currentUtterance = utterance;
    window.speechSynthesis.speak(utterance);
  }

  function renderAgentOutput(text) {
    if (text) {
      ui.agentOutput.innerHTML = `<p>${escapeHtml(text)}</p>`;
      return;
    }
    ui.agentOutput.innerHTML = "<p class=\"empty-box-copy\">agent response...</p>";
  }

  async function sendToAgent(overrides) {
    if (!state.activeThread) {
      setAgentStatus("No active thread to send.", "agent-status-text--error");
      return;
    }

    const inputMode = overrides && overrides.inputMode ? overrides.inputMode : state.prefs.inputMode;
    const payload = {
      agent_id: state.prefs.agentId,
      input_mode: inputMode,
      response_mode: state.prefs.responseMode,
      thread_id: state.activeThread.thread.id,
      snippet_id: null,
      text: ui.agentInput ? ui.agentInput.value.trim() || null : null,
      session_id: state.agentSessionId,
    };

    if (inputMode === "snippet") {
      const snippet = overrides && overrides.snippetId ? state.activeThread.snippets.find((item) => item.id === overrides.snippetId) : getActiveSnippet();
      if (!snippet) {
        if (payload.text) {
          payload.input_mode = "text";
        } else {
          setAgentStatus("Select a snippet or enter dispatch text before sending.", "agent-status-text--error");
          return;
        }
      }
      if (snippet) {
        payload.snippet_id = snippet.id;
        if (!payload.text && ui.agentInput) {
          ui.agentInput.value = snippet.transcript || "";
          payload.text = ui.agentInput.value.trim() || null;
        }
      }
    } else if (inputMode === "thread" && !payload.text && ui.agentInput) {
      ui.agentInput.value = combinedThreadText();
      payload.text = ui.agentInput.value.trim() || null;
    }

    setAgentStatus("Sending to local agent harness...", "agent-status-text--info");
    const result = await api("/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    renderAgentOutput(result.output_text);
    setAgentStatus(`Response from ${result.agent_id}.`, "agent-status-text--success");

    if (result.output_voice_text) {
      speakText(result.output_voice_text);
    }
  }

  async function startRecording() {
    if (state.isRecording) {
      return;
    }
    await api("/api/record/start", { method: "POST" });
    state.isRecording = true;
    ui.micButton.classList.add("mic-button--armed", "mic-button--recording");
    setStatus("Recording into the active snippet stack...", "success");
    syncEditorCaretHint();
  }

  async function stopRecording() {
    if (!state.isRecording || state.stopInFlight || !state.activeThread) {
      return;
    }
    state.stopInFlight = true;
    setStatus("Transcribing snippet and appending to stack...");
    try {
      const result = await api(`/api/record/stop?thread_id=${encodeURIComponent(state.activeThread.thread.id)}`, {
        method: "POST",
      });
      state.isRecording = false;
      ui.micButton.classList.remove("mic-button--armed", "mic-button--recording");
      await refreshWorkspace({ selectSnippetId: result.snippet_id });
      setStatus(`Snippet #${result.snippet_position} appended to ${state.activeThread.thread.title}.`, "success");
      if (state.inlineSnippetRecording) {
        state.activeSnippetId = null;
        renderSnippets();
        renderEditor();
        ui.snippetEditor.focus();
        setEditorStatus("Voice snippet saved. Continue with the next snippet.");
      } else {
        setEditorStatus("Newest voice snippet selected.", "success");
      }
      if (state.prefs.autoSendVoice) {
        await sendToAgent({ inputMode: "snippet", snippetId: result.snippet_id });
      }
    } catch (error) {
      state.isRecording = false;
      ui.micButton.classList.remove("mic-button--armed", "mic-button--recording");
      setStatus(error.message || "Recording failed.", "error");
    } finally {
      state.stopInFlight = false;
      state.inlineSnippetRecording = false;
      syncEditorCaretHint();
    }
  }

  function applyControlPrefs() {
    state.prefs.agentId = ui.agentSelect.value;
    state.prefs.inputMode = ui.inputModeSelect.value;
    state.prefs.responseMode = ui.responseModeSelect ? ui.responseModeSelect.value : "text_only";
    savePrefs();
    renderAgentPrefs();
    setAgentStatus("");
  }

  function bindEvents() {
    if (ui.startNewThread) {
      ui.startNewThread.addEventListener("click", () => {
        createThread().catch((error) => setStatus(error.message, "error"));
      });
    }

    if (ui.startNewThreadInline) {
      ui.startNewThreadInline.addEventListener("click", () => {
        createThread().catch((error) => setStatus(error.message, "error"));
      });
    }

    if (ui.newSnippetInline) {
      ui.newSnippetInline.addEventListener("click", () => {
        createSnippetFromInlineAction().catch((error) => setEditorStatus(error.message, "error"));
      });
    }

    if (ui.snippetCopyInline) {
      ui.snippetCopyInline.addEventListener("click", () => {
        copyEditorText().catch((error) => setEditorStatus(error.message || "Copy failed.", "error"));
      });
    }

    if (ui.snippetDownloadInline) {
      ui.snippetDownloadInline.addEventListener("click", () => {
        downloadEditorText();
      });
    }

    if (ui.switchThread) {
      ui.switchThread.addEventListener("click", () => {
        cycleThread().catch((error) => setStatus(error.message, "error"));
      });
    }

    if (ui.saveThreadTitle) {
      ui.saveThreadTitle.addEventListener("click", () => {
        saveThreadTitle().catch((error) => setEditorStatus(error.message, "error"));
      });
    }

    if (ui.saveSnippet) {
      ui.saveSnippet.addEventListener("click", () => {
        saveSnippetEdit().catch((error) => setEditorStatus(error.message, "error"));
      });
    }

    if (ui.addTextSnippet) {
      ui.addTextSnippet.addEventListener("click", () => {
        addTextSnippet().catch((error) => setEditorStatus(error.message, "error"));
      });
    }

    if (ui.clearActiveThread) {
      ui.clearActiveThread.addEventListener("click", () => {
        clearActiveThread().catch((error) => setStatus(error.message, "error"));
      });
    }

    if (ui.copyThread) {
      ui.copyThread.addEventListener("click", () => {
        copyThread().catch((error) => setEditorStatus(error.message, "error"));
      });
    }

    if (ui.exportThread) {
      ui.exportThread.addEventListener("click", () => {
        exportThread().catch((error) => setEditorStatus(error.message, "error"));
      });
    }

    if (ui.autoSendToggle) {
      ui.autoSendToggle.addEventListener("click", () => {
        state.prefs.autoSendVoice = !state.prefs.autoSendVoice;
        renderAgentPrefs();
      });
    }

    if (ui.sendToAgent) {
      ui.sendToAgent.addEventListener("click", () => {
        sendToAgent().catch((error) => setAgentStatus(error.message, "agent-status-text--error"));
      });
    }

    if (ui.pushSnippetDispatch) {
      ui.pushSnippetDispatch.addEventListener("click", () => {
        (async () => {
          const snippet = await ensureSnippetForDispatch();
          if (!snippet) {
            setAgentStatus("Type text or select a snippet before dispatch.", "agent-status-text--error");
            return;
          }
          if (ui.agentInput) {
            ui.agentInput.value = snippet.transcript || "";
          }
          await sendToAgent({ inputMode: "snippet", snippetId: snippet.id });
        })().catch((error) => setAgentStatus(error.message, "agent-status-text--error"));
      });
    }

    if (ui.pushThreadDispatch) {
      ui.pushThreadDispatch.addEventListener("click", () => {
        if (ui.agentInput) {
          ui.agentInput.value = combinedThreadText();
        }
        sendToAgent({ inputMode: "thread" }).catch((error) => setAgentStatus(error.message, "agent-status-text--error"));
      });
    }

    if (ui.agentSendInline) {
      ui.agentSendInline.addEventListener("click", () => {
        sendToAgent({ inputMode: "text" }).catch((error) => setAgentStatus(error.message, "agent-status-text--error"));
      });
    }

    if (ui.clearAgentOutput) {
      ui.clearAgentOutput.addEventListener("click", () => {
        stopSpeech();
        renderAgentOutput("");
        setAgentStatus("Agent output cleared.");
      });
    }

    if (ui.clearAgentIO) {
      ui.clearAgentIO.addEventListener("click", () => {
        if (ui.agentInput) {
          ui.agentInput.value = "";
        }
        stopSpeech();
        renderAgentOutput("");
        setAgentStatus("Dispatch input and output cleared.");
      });
    }

    if (ui.newAgentSession) {
      ui.newAgentSession.addEventListener("click", () => {
        state.agentSessionId = createSessionId();
        stopSpeech();
        renderAgentOutput("");
        setAgentStatus(`Started new agent session: ${state.agentSessionId.slice(0, 8)}...`, "agent-status-text--info");
      });
    }

    if (ui.openRelay) {
      ui.openRelay.addEventListener("click", () => {
        window.location.href = "html_chat.html";
      });
    }

    ui.agentSelect.addEventListener("change", applyControlPrefs);
    ui.inputModeSelect.addEventListener("change", applyControlPrefs);
    if (ui.responseModeSelect) {
      ui.responseModeSelect.addEventListener("change", applyControlPrefs);
    }

    ui.micButton.addEventListener("click", () => {
      if (state.isRecording) {
        stopRecording();
      } else {
        startRecording().catch((error) => setStatus(error.message, "error"));
      }
    });

    ui.snippetEditor.addEventListener("input", () => {
      syncEditorCaretHint();
    });

    if (ui.syncSettings) {
      ui.syncSettings.addEventListener("click", () => {
        window.location.href = "html_factory.html";
      });
    }

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
      ui.snippetEditor.scrollIntoView({ behavior: "smooth", block: "center" });
      ui.snippetEditor.focus();
    });
    ui.navAndroid.addEventListener("click", () => {
      window.location.href = "html_android.html";
    });

    window.addEventListener("storage", (event) => {
      if (event.key === PREFS_KEY) {
        state.prefs = loadPrefs();
        renderAgentPrefs();
      }
    });
  }

  async function init() {
    bindEvents();
    await hydrateAgentOptions();
    await refreshWorkspace();
    renderAgentOutput("");
    setAgentStatus("");
    setStatus("");
  }

  init().catch((error) => {
    console.error(error);
    setStatus(error.message || "Failed to load workspace.", "error");
  });
})();
