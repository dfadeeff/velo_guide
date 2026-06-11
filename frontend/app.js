const chat = document.getElementById("chat");
const form = document.getElementById("input-form");
const input = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const imageInput = document.getElementById("image-input");
const fastCheckbox = document.getElementById("fast-checkbox");
const imagePreview = document.getElementById("image-preview");
const statusDot = document.getElementById("status-dot");
const statusLabel = document.getElementById("status-label");
const toolStatus = document.getElementById("tool-status");
const timerEl = document.getElementById("timer");

let timerInterval = null;
let queryStart = 0;

function startTimer() {
  queryStart = performance.now();
  timerEl.classList.add("running");
  const tick = () => {
    timerEl.textContent = ((performance.now() - queryStart) / 1000).toFixed(1) + "s";
  };
  tick();
  timerInterval = setInterval(tick, 100);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (queryStart) {
    timerEl.textContent = ((performance.now() - queryStart) / 1000).toFixed(1) + "s";
  }
  timerEl.classList.remove("running");
}

// Encapsulates one in-progress assistant reply: the element it renders into
// and the raw markdown accumulated so far. Replaces shared mutable globals so
// no other code can touch a half-streamed message.
class StreamingMessage {
  #el;
  #raw = "";

  constructor(contentEl) {
    this.#el = contentEl;
  }

  append(delta) {
    this.#raw += delta;
    this.#el.innerHTML = renderMarkdown(this.#raw);
    scrollToBottom();
  }

  // Server signals that prior streamed text was planning preamble — discard it.
  reset() {
    this.#raw = "";
    this.#el.innerHTML = "";
  }

  finalize() {
    this.#el.innerHTML = renderMarkdown(this.#raw);
    scrollToBottom();
  }
}

let ws = null;
let pendingImages = [];
let streamingMsg = null; // StreamingMessage while a reply is in flight
let currentAssistantWrapper = null; // .message.assistant el of the in-flight reply
let isStreaming = false;
let activeTools = new Set();
let hadSession = false; // a "ready" was received before — any later "ready" is a reconnect

// Anonymous, client-generated id — NOT a login. Lets the feedback loop count
// distinct visitors without any identity, auth, or PII. Persisted so repeat
// visits from this browser share an id.
function clientId() {
  let id = localStorage.getItem("velo_client_id");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `c-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("velo_client_id", id);
  }
  return id;
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    statusLabel.textContent = "Connecting...";
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    setStatus("disconnected", "Disconnected");
    sendBtn.disabled = true;
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    setStatus("disconnected", "Error");
  };
}

function setStatus(state, label) {
  statusDot.className = "status-dot " + state;
  statusLabel.textContent = label;
}

function handleMessage(msg) {
  switch (msg.type) {
    case "ready":
      // Each connection gets a fresh agent session server-side, so a reconnect
      // silently loses the conversation. Say so — otherwise the user keeps
      // refining a plan the agent no longer remembers.
      if (hadSession) {
        addSystemNote("Connection was lost and a new conversation has started — the previous plan's context was cleared. Please re-state your request.");
      }
      hadSession = true;
      setStatus("connected", "Ready");
      sendBtn.disabled = false;
      break;

    case "response_start": {
      isStreaming = true;
      setStatus("thinking", "Thinking...");
      const contentEl = addMessage("assistant", "");
      currentAssistantWrapper = contentEl.parentElement;
      streamingMsg = new StreamingMessage(contentEl);
      activeTools.clear();
      toolStatus.innerHTML = "";
      startTimer();
      break;
    }

    case "delta":
      streamingMsg?.append(msg.text);
      break;

    case "reset":
      streamingMsg?.reset();
      break;

    case "tool_start":
      activeTools.add(msg.name);
      updateToolChips();
      setStatus("thinking", `Using ${msg.label || msg.name}...`);
      break;

    case "tool_end":
      activeTools.delete(msg.name);
      updateToolChips();
      if (activeTools.size === 0) {
        setStatus("thinking", "Thinking...");
      }
      break;

    case "response_end":
      isStreaming = false;
      stopTimer();
      setStatus("connected", "Ready");
      sendBtn.disabled = false;
      activeTools.clear();
      toolStatus.innerHTML = "";
      streamingMsg?.finalize();
      streamingMsg = null;
      // turn_id is sent only when the backend's feedback capture is enabled —
      // render the thumbs up/down controls just for that reply.
      if (msg.turn_id && currentAssistantWrapper) attachFeedback(currentAssistantWrapper, msg.turn_id);
      currentAssistantWrapper = null;
      break;

    case "reset_done":
      // Fresh server session — clear the conversation so the user starts clean.
      chat.innerHTML = "";
      addSystemNote("New trip — started a fresh conversation. Previous context cleared.");
      setStatus("connected", "Ready");
      sendBtn.disabled = false;
      break;

    case "error":
      stopTimer();
      setStatus("connected", "Ready");
      isStreaming = false;
      sendBtn.disabled = false;
      addMessage("assistant", `Error: ${msg.message}`);
      break;
  }
}

// "New trip": ask the server for a fresh session (see server reset handler).
document.getElementById("new-trip-btn")?.addEventListener("click", () => {
  if (isStreaming) return;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "reset" }));
});

// Thumbs up/down on a delivered plan. One POST to /feedback; a downvote first
// reveals an optional one-line reason box (the most useful signal for the eval
// loop). The server joins this rating to the plan + tool trace it buffered for
// this turn_id — the client never sends the plan back.
function attachFeedback(wrapperEl, turnId) {
  const bar = document.createElement("div");
  bar.className = "feedback-bar";

  const mkBtn = (label, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "feedback-btn";
    b.textContent = label;
    if (title) b.title = title;
    return b;
  };

  const done = (text) => {
    bar.innerHTML = "";
    const note = document.createElement("span");
    note.className = "feedback-ask";
    note.textContent = text;
    bar.appendChild(note);
  };

  const submit = (rating, comment) => {
    fetch("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId(), turn_id: turnId, rating, comment: comment || null }),
    }).catch(() => {});
    done("Thanks for the feedback 🙏");
  };

  const ask = document.createElement("span");
  ask.className = "feedback-ask";
  ask.textContent = "Was this helpful?";
  const up = mkBtn("👍", "This plan was good");
  const down = mkBtn("👎", "Something was off");
  bar.append(ask, up, down);

  up.onclick = () => submit("up", null);
  down.onclick = () => {
    bar.innerHTML = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "feedback-comment";
    input.placeholder = "What was off? (optional) — Enter to send";
    input.maxLength = 1000;
    const send = mkBtn("Send", "Send feedback");
    bar.append(input, send);
    input.focus();
    const go = () => submit("down", input.value.trim());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      }
    });
    send.onclick = go;
  };

  wrapperEl.appendChild(bar);
  scrollToBottom();
}

function addSystemNote(text) {
  const wrapper = document.createElement("div");
  wrapper.className = "message system";
  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = text;
  wrapper.appendChild(content);
  chat.appendChild(wrapper);
  scrollToBottom();
}

function addMessage(role, text) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const content = document.createElement("div");
  content.className = "message-content";
  wrapper.appendChild(content);
  chat.appendChild(wrapper);

  if (role === "assistant") {
    content.innerHTML = text ? renderMarkdown(text) : "";
  } else {
    content.textContent = text;
  }

  scrollToBottom();
  return content;
}

function renderMarkdown(text) {
  if (typeof marked !== "undefined") {
    return marked.parse(text, { breaks: true });
  }
  return text.replace(/\n/g, "<br>");
}

function updateToolChips() {
  toolStatus.innerHTML = "";
  for (const name of activeTools) {
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.innerHTML = `<span class="spinner"></span> ${formatToolName(name)}`;
    toolStatus.appendChild(chip);
  }
}

function formatToolName(name) {
  const labels = {
    geocode: "Geocoding",
    plan_route: "Planning route",
    get_weather: "Checking weather",
    find_pois: "Finding places",
    find_accommodation: "Finding stays",
    find_knooppunten: "Finding junctions",
    web_search: "Searching web",
  };
  return labels[name] || name;
}

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

// Input handling
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.dispatchEvent(new Event("submit"));
  }
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && !pendingImages.length) return;
  if (isStreaming) return;

  // Show user message with images
  const msgEl = addMessage("user", text);
  if (pendingImages.length) {
    const imgContainer = document.createElement("div");
    imgContainer.className = "message-images";
    for (const img of pendingImages) {
      const imgEl = document.createElement("img");
      imgEl.src = `data:${img.mimeType};base64,${img.data}`;
      imgContainer.appendChild(imgEl);
    }
    msgEl.parentElement.insertBefore(imgContainer, msgEl);
  }

  // Send to server
  const payload = { type: "prompt", text: text || "What do you see in this image?" };
  if (pendingImages.length) {
    payload.images = pendingImages;
  }
  // Always send the flag so the server knows detailed was explicitly chosen
  // (fast is the default; unchecking opts into a fuller plan).
  payload.fast = !!fastCheckbox?.checked;
  ws.send(JSON.stringify(payload));

  // Reset
  input.value = "";
  input.style.height = "auto";
  pendingImages = [];
  imagePreview.innerHTML = "";
  sendBtn.disabled = true;
});

// Image upload
imageInput.addEventListener("change", () => {
  const files = Array.from(imageInput.files);
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      pendingImages.push({ data: base64, mimeType: file.type });

      const item = document.createElement("div");
      item.className = "preview-item";
      const img = document.createElement("img");
      img.src = reader.result;
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "×";
      removeBtn.onclick = () => {
        const idx = Array.from(imagePreview.children).indexOf(item);
        pendingImages.splice(idx, 1);
        item.remove();
      };
      item.appendChild(img);
      item.appendChild(removeBtn);
      imagePreview.appendChild(item);
    };
    reader.readAsDataURL(file);
  }
  imageInput.value = "";
});

// Voice input — browser-side speech-to-text via the Web Speech API
// (Chrome/Edge/Safari). The transcript lands in the text box and is sent as a
// normal text prompt, so the backend stays text+image only and every grounding
// rule applies unchanged. The button hides itself where the API is unsupported
// (e.g. Firefox); typing always works.
class VoiceInput {
  #recognition;
  #button;
  #textarea;
  #baseText = "";
  #active = false;

  constructor(button, textarea) {
    const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionImpl) {
      button.style.display = "none";
      return;
    }
    this.#button = button;
    this.#textarea = textarea;
    this.#recognition = new SpeechRecognitionImpl();
    this.#recognition.lang = navigator.language || "en-US";
    this.#recognition.interimResults = true;
    this.#recognition.continuous = false;

    this.#recognition.onresult = (e) => {
      let transcript = "";
      for (const result of e.results) transcript += result[0].transcript;
      this.#textarea.value = `${this.#baseText} ${transcript}`.trim();
      this.#textarea.dispatchEvent(new Event("input")); // re-run autosize
    };
    this.#recognition.onend = () => this.#setActive(false);
    this.#recognition.onerror = () => this.#setActive(false);

    button.addEventListener("click", () => this.#toggle());
  }

  #toggle() {
    if (this.#active) {
      this.#recognition.stop();
      this.#setActive(false);
      return;
    }
    this.#baseText = this.#textarea.value;
    try {
      this.#recognition.start();
      this.#setActive(true);
    } catch {
      this.#setActive(false);
    }
  }

  #setActive(on) {
    this.#active = on;
    this.#button.classList.toggle("recording", on);
    this.#button.title = on
      ? "Listening… click to stop"
      : "Voice input — speech is transcribed in your browser and sent as text";
  }
}

// --- Server-STT voice path (used when the backend has STT_BACKEND set) --------
// Records a clip, re-encodes it to WAV in the browser (so the server backend —
// Gemini or Deepgram — always gets a format it accepts regardless of the native
// recording codec), uploads it to /transcribe, and drops the transcript into the
// text box. Same end result as the browser path: text in, all grounding applies.
function pickAudioMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function blobToWav(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    return audioBufferToWavBlob(await ctx.decodeAudioData(await blob.arrayBuffer()));
  } finally {
    ctx.close();
  }
}

// Mono 16-bit PCM WAV from an AudioBuffer (first channel is plenty for speech).
function audioBufferToWavBlob(buffer) {
  const ch = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const view = new DataView(new ArrayBuffer(44 + ch.length * 2));
  let p = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); };
  const u32 = (v) => { view.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { view.setUint16(p, v, true); p += 2; };
  str("RIFF"); u32(36 + ch.length * 2); str("WAVE");
  str("fmt "); u32(16); u16(1); u16(1); u32(sr); u32(sr * 2); u16(2); u16(16);
  str("data"); u32(ch.length * 2);
  for (let i = 0; i < ch.length; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    p += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

class ServerVoiceInput {
  #button;
  #textarea;
  #recorder = null;
  #chunks = [];
  #stream = null;
  #baseText = "";
  #state = "idle";

  constructor(button, textarea) {
    this.#button = button;
    this.#textarea = textarea;
    button.addEventListener("click", () => this.#toggle());
    this.#setState("idle");
  }

  async #toggle() {
    if (this.#state === "recording") return this.#stopRecording();
    if (this.#state === "transcribing") return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.#flash("Mic blocked");
      return;
    }
    this.#stream = stream;
    const mime = pickAudioMime();
    this.#recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.#chunks = [];
    this.#baseText = this.#textarea.value;
    this.#recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.#chunks.push(e.data);
    };
    this.#recorder.onstop = () => this.#finish();
    this.#recorder.start();
    this.#setState("recording");
  }

  #stopRecording() {
    this.#setState("transcribing");
    try {
      this.#recorder?.stop();
    } catch {}
    this.#stream?.getTracks().forEach((t) => t.stop());
  }

  async #finish() {
    try {
      const blob = new Blob(this.#chunks, { type: this.#recorder?.mimeType || "audio/webm" });
      if (!blob.size) {
        addSystemNote("🎤 No audio captured — check that the mic is working and try again.");
        return;
      }
      const wav = await blobToWav(blob);
      const res = await fetch("/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: await blobToBase64(wav), mimeType: "audio/wav" }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.text) {
        // The transcript goes into the INPUT box (not the chat) so you review/edit
        // before sending — highlight it briefly so it's obvious where it landed.
        this.#textarea.value = `${this.#baseText} ${json.text}`.trim();
        this.#textarea.dispatchEvent(new Event("input"));
        this.#textarea.focus();
        this.#textarea.classList.add("just-transcribed");
        setTimeout(() => this.#textarea.classList.remove("just-transcribed"), 1200);
      } else if (res.ok) {
        // 200 but empty → the model heard no intelligible speech.
        addSystemNote("🎤 Didn't catch any speech — try again, speaking clearly into the mic.");
      } else {
        addSystemNote(`🎤 Transcription failed: ${json.error || res.statusText}`);
      }
    } catch (err) {
      addSystemNote(`🎤 Could not transcribe the recording (${err?.message || "audio error"}).`);
    } finally {
      this.#setState("idle");
    }
  }

  #setState(s) {
    this.#state = s;
    this.#button.classList.toggle("recording", s === "recording");
    this.#button.classList.toggle("transcribing", s === "transcribing");
    this.#button.title =
      s === "recording"
        ? "Recording… click to stop"
        : s === "transcribing"
          ? "Transcribing…"
          : "Voice input — recorded and transcribed on the server";
  }

  #flash(msg) {
    const prev = this.#textarea.placeholder;
    this.#textarea.placeholder = msg;
    setTimeout(() => {
      this.#textarea.placeholder = prev;
    }, 2000);
  }
}

// Pick the voice path from server config: browser Web Speech API by default, or
// record+upload when the backend advertises a server STT backend.
async function initVoice() {
  const btn = document.getElementById("mic-btn");
  let mode = "browser";
  try {
    const r = await fetch("/config");
    if (r.ok) mode = (await r.json()).stt || "browser";
  } catch {}
  const canRecord = window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (mode !== "browser" && canRecord) new ServerVoiceInput(btn, input);
  else new VoiceInput(btn, input); // browser Web Speech API (hides itself if unsupported)
}

initVoice();
connect();
