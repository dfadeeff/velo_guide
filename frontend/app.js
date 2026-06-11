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
let isStreaming = false;
let activeTools = new Set();
let hadSession = false; // a "ready" was received before — any later "ready" is a reconnect

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

    case "response_start":
      isStreaming = true;
      setStatus("thinking", "Thinking...");
      streamingMsg = new StreamingMessage(addMessage("assistant", ""));
      activeTools.clear();
      toolStatus.innerHTML = "";
      startTimer();
      break;

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

new VoiceInput(document.getElementById("mic-btn"), input);

connect();
