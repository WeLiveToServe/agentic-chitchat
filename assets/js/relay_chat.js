(function () {
  const API_BASE_CANDIDATES = window.location.origin.includes("localhost") || window.location.origin.includes("127.0.0.1")
    ? ["http://127.0.0.1:7100", "http://127.0.0.1:7000"]
    : [window.API_BASE_URL || "http://127.0.0.1:7100", "http://127.0.0.1:7000"];
  let cachedApiBase = null;

  const state = {
    conversations: [],
    activeConversation: null,
    displayMode: "timeline",
    isRecording: false,
    stopInFlight: false,
    isPlaying: false,
    playbackAbort: false,
    currentAudio: null,
    currentMessageId: null,
    telegramStatus: null,
  };

  const ui = {
    conversationCountChip: document.getElementById("conversation-count-chip"),
    activeTransportChip: document.getElementById("active-transport-chip"),
    telegramStatusChip: document.getElementById("telegram-status-chip"),
    activeConversationChip: document.getElementById("active-conversation-chip"),
    messageCountChip: document.getElementById("message-count-chip"),
    conversationList: document.getElementById("conversation-list"),
    conversationTitleInput: document.getElementById("conversation-title-input"),
    saveConversationTitle: document.getElementById("save-conversation-title"),
    modeTimeline: document.getElementById("mode-timeline"),
    modeThread: document.getElementById("mode-thread"),
    participantRig: document.getElementById("participant-rig"),
    relayFeed: document.getElementById("relay-feed"),
    playConversation: document.getElementById("play-conversation"),
    stopPlayback: document.getElementById("stop-playback"),
    clearConversationOutput: document.getElementById("clear-conversation-output"),
    playbackStatus: document.getElementById("playback-status"),
    conversationModeChip: document.getElementById("conversation-mode-chip"),
    composeTransportSelect: document.getElementById("compose-transport-select"),
    senderRoleChip: document.getElementById("sender-role-chip"),
    transportNote: document.getElementById("transport-note"),
    senderSelect: document.getElementById("sender-select"),
    messageEditor: document.getElementById("message-editor"),
    sendTextMessage: document.getElementById("send-text-message"),
    sendVoiceChit: document.getElementById("send-voice-chit"),
    composerStatus: document.getElementById("composer-status"),
    newLocalConversation: document.getElementById("new-local-conversation"),
    newOpenclawConversation: document.getElementById("new-openclaw-conversation"),
    newGeminiConversation: document.getElementById("new-gemini-conversation"),
    switchConversation: document.getElementById("switch-conversation"),
    openRedline: document.getElementById("open-redline"),
    openFactory: document.getElementById("open-factory"),
    bannerChat: document.getElementById("banner-chat"),
    bannerMic: document.getElementById("banner-mic"),
    bannerBot: document.getElementById("banner-bot"),
    navChat: document.getElementById("nav-chat"),
    navProfile: document.getElementById("nav-profile"),
    navRecorder: document.getElementById("nav-recorder"),
    navEditor: document.getElementById("nav-editor"),
    navAndroid: document.getElementById("nav-android"),
  };

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

  function apiUrl(path) {
    const base = cachedApiBase || API_BASE_CANDIDATES[0];
    return `${base}${path}`;
  }

  function setComposerStatus(message, toneClass) {
    ui.composerStatus.textContent = message || "";
    ui.composerStatus.className = "relay-status-line";
    if (toneClass) {
      ui.composerStatus.classList.add(toneClass);
    }
  }

  function setPlaybackStatus(message, toneClass) {
    ui.playbackStatus.textContent = message || "";
    ui.playbackStatus.className = "relay-status-line";
    if (toneClass) {
      ui.playbackStatus.classList.add(toneClass);
    }
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

  function getParticipants() {
    return state.activeConversation ? state.activeConversation.participants : [];
  }

  function getMessages() {
    return state.activeConversation ? state.activeConversation.messages : [];
  }

  function getMessageSender(message) {
    return getParticipants().find((participant) => participant.id === message.sender_id) || null;
  }

  function selectableParticipants() {
    const participants = getParticipants();
    const transport = state.activeConversation ? state.activeConversation.conversation.transport : "local";
    if (transport === "local") {
      return participants.filter((participant) => participant.role !== "agent");
    }
    return participants.filter((participant) => participant.is_self);
  }

  function combinedConversationText() {
    return getMessages()
      .map((message) => {
        const sender = getMessageSender(message);
        return `${sender ? sender.display_name : "Unknown"}: ${message.transcript}`;
      })
      .join("\n");
  }

  function renderConversationList() {
    ui.conversationCountChip.textContent = `${state.conversations.length} conversation${state.conversations.length === 1 ? "" : "s"}`;
    ui.conversationList.innerHTML = "";
    state.conversations.forEach((conversation) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `conversation-card${conversation.is_active ? " conversation-card--active" : ""}`;
      card.innerHTML = `
        <p class="conversation-card__title">${escapeHtml(conversation.title)}</p>
        <p class="conversation-card__meta">${conversation.message_count} message${conversation.message_count === 1 ? "" : "s"}</p>
        <p class="conversation-card__preview">${escapeHtml(conversation.latest_message_preview || "Waiting for first note")}</p>
      `;
      card.addEventListener("click", () => {
        activateConversation(conversation.id).catch((error) => setComposerStatus(error.message, "error"));
      });
      ui.conversationList.appendChild(card);
    });
  }

  function renderParticipants() {
    ui.participantRig.innerHTML = "";
    const participants = getParticipants();
    participants.forEach((participant) => {
      const card = document.createElement("article");
      const playing = state.currentMessageId
        ? getMessages().some((message) => message.id === state.currentMessageId && message.sender_id === participant.id)
        : false;
      card.className = `participant-card${playing ? " participant-card--playing" : ""}`;
      card.dataset.participantId = participant.id;
      card.innerHTML = `
        <div class="participant-card__avatar" style="background:${participant.pfp_tint};">${escapeHtml(participant.pfp_label)}</div>
        <div>
          <p class="participant-card__name">${escapeHtml(participant.display_name)}</p>
          <p class="participant-card__handle">${escapeHtml(participant.handle || participant.role)}</p>
        </div>
        <div class="participant-card__overlay"></div>
      `;
      ui.participantRig.appendChild(card);
    });
  }

  function renderSenderOptions() {
    const currentValue = ui.senderSelect.value;
    ui.senderSelect.innerHTML = "";
    const candidates = selectableParticipants();
    if (!candidates.length) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "No sender available";
      empty.disabled = true;
      empty.selected = true;
      ui.senderSelect.appendChild(empty);
      syncSenderChip();
      return;
    }
    candidates.forEach((participant) => {
      const option = document.createElement("option");
      option.value = participant.id;
      option.textContent = participant.display_name;
      ui.senderSelect.appendChild(option);
    });
    if (candidates.some((participant) => participant.id === currentValue)) {
      ui.senderSelect.value = currentValue;
    } else if (candidates.length) {
      ui.senderSelect.value = candidates[0].id;
    }
    syncSenderChip();
  }

  function renderStageMeta() {
    const active = state.activeConversation;
    const conversation = active ? active.conversation : null;
    ui.activeConversationChip.textContent = conversation ? conversation.title : "No active chat";
    ui.messageCountChip.textContent = `${getMessages().length} messages`;
    ui.conversationTitleInput.value = conversation ? conversation.title : "";
    ui.activeTransportChip.textContent = conversation ? conversation.transport.replace(/_/g, " ") : "local relay";
    if (ui.composeTransportSelect && conversation) {
      ui.composeTransportSelect.value = conversation.transport;
    }
    if (conversation && conversation.transport === "telegram_openclaw") {
      ui.conversationModeChip.textContent = "Telegram OpenClaw";
      ui.transportNote.textContent = "Messages from You route into OpenClaw. Replies return as a local Telegram stub until the bot token goes live.";
    } else if (conversation && conversation.transport === "gemini_flash_channel") {
      ui.conversationModeChip.textContent = "Gemini Flash Channel";
      ui.transportNote.textContent = "Use this isolated channel for Gemini-only tests. Replies are generated here without touching OpenClaw Telegram context.";
    } else {
      ui.conversationModeChip.textContent = "Local friend relay";
      ui.transportNote.textContent = "Swap sender to simulate both sides. Voice notes persist and play back in order.";
    }
  }

  function renderFeed() {
    ui.relayFeed.className = `relay-feed ${state.displayMode === "thread" ? "relay-feed--thread" : "relay-feed--timeline"}`;
    ui.relayFeed.innerHTML = "";
    const messages = getMessages();
    if (!messages.length) {
      ui.relayFeed.innerHTML = "<p class=\"transcription-placeholder\">No messages yet. Send text or record a voice note.</p>";
      return;
    }
    messages.forEach((message) => {
      const sender = getMessageSender(message);
      const isSelf = sender ? sender.is_self : false;
      const card = document.createElement("article");
      const activeClass = message.id === state.currentMessageId ? " message-card--active" : "";
      const threadClass = state.displayMode === "thread" ? ` ${isSelf ? "message-card--self" : "message-card--other"}` : "";
      card.className = `message-card${activeClass}${threadClass}`;
      card.dataset.messageId = message.id;
      card.innerHTML = `
        <p class="message-card__meta">${escapeHtml(sender ? sender.display_name : "Unknown")} // ${escapeHtml(message.message_type)} // ${formatTimestamp(message.created_at)}</p>
        <p class="message-card__body">${escapeHtml(message.transcript)}</p>
        <div class="message-card__actions">
          <button class="action-button message-card__play" type="button">Play</button>
          <span class="chip">${escapeHtml(message.delivery_state)}</span>
        </div>
      `;
      card.querySelector(".message-card__play").addEventListener("click", () => {
        playSingleMessage(message.id).catch((error) => setPlaybackStatus(error.message, "error"));
      });
      ui.relayFeed.appendChild(card);
    });
  }

  function renderModeButtons() {
    ui.modeTimeline.classList.toggle("pill-button--active", state.displayMode === "timeline");
    ui.modeThread.classList.toggle("pill-button--active", state.displayMode === "thread");
  }

  function renderTelegramStatus() {
    if (!state.telegramStatus) {
      ui.telegramStatusChip.textContent = "telegram stub";
      return;
    }
    ui.telegramStatusChip.textContent = state.telegramStatus.configured ? "telegram live" : "telegram stub";
  }

  function renderAll() {
    renderConversationList();
    renderParticipants();
    renderSenderOptions();
    renderStageMeta();
    renderFeed();
    renderModeButtons();
    renderTelegramStatus();
  }

  async function loadConversations() {
    state.conversations = await api("/api/conversations");
  }

  async function loadActiveConversation() {
    state.activeConversation = await api("/api/conversations/active");
  }

  async function loadTelegramStatus() {
    state.telegramStatus = await api("/api/integrations/telegram/status");
  }

  async function refreshRelay() {
    await Promise.all([loadConversations(), loadActiveConversation(), loadTelegramStatus()]);
    renderAll();
  }

  async function activateConversation(conversationId) {
    state.activeConversation = await api(`/api/conversations/${conversationId}/activate`, { method: "POST" });
    await loadConversations();
    renderAll();
    setComposerStatus(`Switched to ${state.activeConversation.conversation.title}.`, "success");
  }

  async function createConversation(transport) {
    const detail = await api("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transport }),
    });
    state.activeConversation = detail;
    await loadConversations();
    renderAll();
    const label = transport === "telegram_openclaw"
      ? "OpenClaw channel"
      : transport === "gemini_flash_channel"
        ? "Gemini Flash channel"
        : "local relay";
    setComposerStatus(`New ${label} ready.`, "success");
  }

  async function ensureConversationForTransport(transport) {
    if (state.activeConversation && state.activeConversation.conversation.transport === transport) {
      return state.activeConversation;
    }
    const existing = state.conversations.find((conversation) => conversation.transport === transport);
    if (existing) {
      await activateConversation(existing.id);
      return state.activeConversation;
    }
    await createConversation(transport);
    return state.activeConversation;
  }

  async function saveConversationTitle() {
    if (!state.activeConversation) {
      return;
    }
    const title = ui.conversationTitleInput.value.trim();
    if (!title) {
      setComposerStatus("Conversation title cannot be empty.", "error");
      return;
    }
    const summary = await api(`/api/conversations/${state.activeConversation.conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    state.activeConversation.conversation = summary;
    await loadConversations();
    renderAll();
    setComposerStatus("Conversation title saved.", "success");
  }

  function syncSenderChip() {
    const sender = selectableParticipants().find((participant) => participant.id === ui.senderSelect.value);
    ui.senderRoleChip.textContent = sender ? sender.display_name : "You";
  }

  async function sendTextMessage() {
    const selectedTransport = ui.composeTransportSelect ? ui.composeTransportSelect.value : "local";
    await ensureConversationForTransport(selectedTransport);
    if (!state.activeConversation) {
      setComposerStatus("No active conversation.", "error");
      return;
    }
    const transcript = ui.messageEditor.value.trim();
    if (!transcript) {
      setComposerStatus("Write a message before sending.", "error");
      return;
    }
    const senderId = ui.senderSelect.value;
    state.activeConversation = await api(`/api/conversations/${state.activeConversation.conversation.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender_id: senderId, transcript, message_type: "text" }),
    });
    await loadConversations();
    renderAll();
    ui.messageEditor.value = "";
    setComposerStatus("Message sent.", "success");
  }

  async function startRecording() {
    const selectedTransport = ui.composeTransportSelect ? ui.composeTransportSelect.value : "local";
    await ensureConversationForTransport(selectedTransport);
    if (!state.activeConversation || state.isRecording) {
      return;
    }
    const senderId = ui.senderSelect.value;
    if (!senderId) {
      setComposerStatus("Select a sender before recording.", "error");
      return;
    }
    await api(`/api/conversations/${state.activeConversation.conversation.id}/record/start?sender_id=${encodeURIComponent(senderId)}`, {
      method: "POST",
    });
    state.isRecording = true;
    if (ui.sendVoiceChit) {
      ui.sendVoiceChit.classList.add("pill-button--active");
      ui.sendVoiceChit.textContent = "Stop Voice Chit";
    }
    setComposerStatus("Recording voice chit...", "success");
  }

  async function stopRecording() {
    if (!state.activeConversation || !state.isRecording || state.stopInFlight) {
      return;
    }
    state.stopInFlight = true;
    setComposerStatus("Transcribing voice note...");
    try {
      const senderId = ui.senderSelect.value;
      state.activeConversation = await api(`/api/conversations/${state.activeConversation.conversation.id}/record/stop?sender_id=${encodeURIComponent(senderId)}`, {
        method: "POST",
      });
      await loadConversations();
      renderAll();
      setComposerStatus("Voice note added to conversation.", "success");
    } catch (error) {
      setComposerStatus(error.message || "Voice note failed.", "error");
    } finally {
      state.stopInFlight = false;
      state.isRecording = false;
      if (ui.sendVoiceChit) {
        ui.sendVoiceChit.classList.remove("pill-button--active");
        ui.sendVoiceChit.textContent = "Send Voice Chit";
      }
    }
  }

  function clearPlaybackHighlights() {
    state.currentMessageId = null;
    Array.from(ui.participantRig.children).forEach((card) => {
      card.classList.remove("participant-card--playing");
      const overlay = card.querySelector(".participant-card__overlay");
      if (overlay) {
        overlay.textContent = "";
      }
    });
  }

  function stopSpeech() {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  function stopPlaybackInternals() {
    state.playbackAbort = true;
    state.isPlaying = false;
    if (state.currentAudio) {
      state.currentAudio.pause();
      state.currentAudio = null;
    }
    stopSpeech();
    clearPlaybackHighlights();
    renderFeed();
  }

  function speakText(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis || !text) {
        resolve();
        return;
      }
      stopSpeech();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 0.94;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    });
  }

  function playAudio(message) {
    return new Promise((resolve) => {
      if (!message.audio_url) {
        resolve();
        return;
      }
      const audio = new Audio(apiUrl(message.audio_url));
      state.currentAudio = audio;
      audio.onended = () => {
        state.currentAudio = null;
        resolve();
      };
      audio.onerror = () => {
        state.currentAudio = null;
        resolve();
      };
      audio.play().catch(() => {
        state.currentAudio = null;
        resolve();
      });
    });
  }

  function highlightMessage(message) {
    state.currentMessageId = message.id;
    clearPlaybackHighlights();
    state.currentMessageId = message.id;
    const sender = getMessageSender(message);
    if (sender) {
      const card = ui.participantRig.querySelector(`[data-participant-id="${sender.id}"]`);
      if (card) {
        card.classList.add("participant-card--playing");
        const overlay = card.querySelector(".participant-card__overlay");
        if (overlay) {
          overlay.textContent = message.transcript;
        }
      }
    }
    renderFeed();
    const activeCard = ui.relayFeed.querySelector(`[data-message-id="${message.id}"]`);
    if (activeCard) {
      activeCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  async function playMessageByObject(message) {
    highlightMessage(message);
    if (message.audio_url) {
      await playAudio(message);
      if (state.playbackAbort) {
        return;
      }
    } else {
      await speakText(message.transcript);
    }
  }

  async function playSingleMessage(messageId) {
    const message = getMessages().find((item) => item.id === messageId);
    if (!message) {
      return;
    }
    stopPlaybackInternals();
    state.playbackAbort = false;
    state.isPlaying = true;
    setPlaybackStatus("Playing message...", "success");
    await playMessageByObject(message);
    if (!state.playbackAbort) {
      clearPlaybackHighlights();
      renderFeed();
      setPlaybackStatus("Message playback finished.");
    }
    state.isPlaying = false;
  }

  async function playConversation() {
    const messages = getMessages();
    if (!messages.length) {
      setPlaybackStatus("Nothing to play.", "error");
      return;
    }
    stopPlaybackInternals();
    state.playbackAbort = false;
    state.isPlaying = true;
    setPlaybackStatus("Playing conversation in chronological order...", "success");
    for (const message of messages) {
      if (state.playbackAbort) {
        break;
      }
      await playMessageByObject(message);
    }
    if (state.playbackAbort) {
      setPlaybackStatus("Playback stopped.");
    } else {
      setPlaybackStatus("Conversation playback finished.");
    }
    clearPlaybackHighlights();
    renderFeed();
    state.isPlaying = false;
    state.playbackAbort = false;
  }

  function cycleConversation() {
    if (!state.conversations.length) {
      return Promise.resolve();
    }
    const currentIndex = state.conversations.findIndex((conversation) => conversation.is_active);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % state.conversations.length : 0;
    return activateConversation(state.conversations[nextIndex].id);
  }

  function bindEvents() {
    if (ui.newLocalConversation) {
      ui.newLocalConversation.addEventListener("click", () => {
        createConversation("local").catch((error) => setComposerStatus(error.message, "error"));
      });
    }
    if (ui.newOpenclawConversation) {
      ui.newOpenclawConversation.addEventListener("click", () => {
        createConversation("telegram_openclaw").catch((error) => setComposerStatus(error.message, "error"));
      });
    }
    if (ui.newGeminiConversation) {
      ui.newGeminiConversation.addEventListener("click", () => {
        createConversation("gemini_flash_channel").catch((error) => setComposerStatus(error.message, "error"));
      });
    }
    if (ui.switchConversation) {
      ui.switchConversation.addEventListener("click", () => {
        cycleConversation().catch((error) => setComposerStatus(error.message, "error"));
      });
    }
    if (ui.saveConversationTitle) {
      ui.saveConversationTitle.addEventListener("click", () => {
        saveConversationTitle().catch((error) => setComposerStatus(error.message, "error"));
      });
    }
    if (ui.modeTimeline) {
      ui.modeTimeline.addEventListener("click", () => {
        state.displayMode = "timeline";
        renderModeButtons();
        renderFeed();
      });
    }
    if (ui.modeThread) {
      ui.modeThread.addEventListener("click", () => {
        state.displayMode = "thread";
        renderModeButtons();
        renderFeed();
      });
    }
    if (ui.senderSelect) {
      ui.senderSelect.addEventListener("change", syncSenderChip);
    }
    if (ui.composeTransportSelect) {
      ui.composeTransportSelect.addEventListener("change", () => {
        const transport = ui.composeTransportSelect.value;
        ensureConversationForTransport(transport)
          .then(() => setComposerStatus(`Switched compose transport to ${transport.replace(/_/g, " ")}.`, "success"))
          .catch((error) => setComposerStatus(error.message, "error"));
      });
    }
    if (ui.sendTextMessage) {
      ui.sendTextMessage.addEventListener("click", () => {
        sendTextMessage().catch((error) => setComposerStatus(error.message, "error"));
      });
    }
    if (ui.sendVoiceChit) {
      ui.sendVoiceChit.addEventListener("click", () => {
        if (state.isRecording) {
          stopRecording();
        } else {
          startRecording().catch((error) => setComposerStatus(error.message, "error"));
        }
      });
    }
    if (ui.playConversation) {
      ui.playConversation.addEventListener("click", () => {
        playConversation().catch((error) => setPlaybackStatus(error.message, "error"));
      });
    }
    if (ui.stopPlayback) {
      ui.stopPlayback.addEventListener("click", () => {
        stopPlaybackInternals();
        setPlaybackStatus("Playback stopped.");
      });
    }
    if (ui.clearConversationOutput) {
      ui.clearConversationOutput.addEventListener("click", () => {
        ui.messageEditor.value = "";
        setComposerStatus("Composer cleared.");
      });
    }
    if (ui.openRedline) {
      ui.openRedline.addEventListener("click", () => {
        window.location.href = "html_redline.html";
      });
    }
    if (ui.openFactory) {
      ui.openFactory.addEventListener("click", () => {
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
    if (ui.navChat) {
      ui.navChat.addEventListener("click", () => {
        window.location.href = "html_chat.html";
      });
    }
    if (ui.navProfile) {
      ui.navProfile.addEventListener("click", () => {
        window.location.href = "html_profile.html";
      });
    }
    if (ui.navRecorder) {
      ui.navRecorder.addEventListener("click", () => {
        window.location.href = "html_redline.html";
      });
    }
    if (ui.navEditor) {
      ui.navEditor.addEventListener("click", () => {
        window.location.href = "html_factory.html";
      });
    }
    if (ui.navAndroid) {
      ui.navAndroid.addEventListener("click", () => {
        window.location.href = "html_android.html";
      });
    }
  }

  async function init() {
    bindEvents();
    await refreshRelay();
    setComposerStatus("Ready.");
    setPlaybackStatus("Select a message or play the entire conversation.");
  }

  init().catch((error) => {
    console.error(error);
    setComposerStatus(error.message || "Failed to load relay.", "error");
  });
})();
