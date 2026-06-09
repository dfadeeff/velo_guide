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

let ws = null;
let pendingImages = [];
let currentAssistantMsg = null;
let isStreaming = false;
let activeTools = new Set();

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
      setStatus("connected", "Ready");
      sendBtn.disabled = false;
      break;

    case "response_start":
      isStreaming = true;
      setStatus("thinking", "Thinking...");
      currentAssistantMsg = addMessage("assistant", "");
      activeTools.clear();
      toolStatus.innerHTML = "";
      startTimer();
      break;

    case "delta":
      if (currentAssistantMsg) {
        appendDelta(currentAssistantMsg, msg.text);
      }
      break;

    case "reset":
      // Server signals that prior streamed text was planning preamble — discard
      // it so only the final itinerary (after the last tool) is shown.
      if (currentAssistantMsg) {
        rawText = "";
        currentAssistantMsg.innerHTML = "";
      }
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
      if (currentAssistantMsg) {
        finalizeMessage(currentAssistantMsg);
      }
      currentAssistantMsg = null;
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

let rawText = "";

function addMessage(role, text) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  const content = document.createElement("div");
  content.className = "message-content";
  wrapper.appendChild(content);
  chat.appendChild(wrapper);

  if (role === "assistant") {
    rawText = text;
    content.innerHTML = text ? renderMarkdown(text) : "";
  } else {
    content.textContent = text;
  }

  scrollToBottom();
  return content;
}

function appendDelta(el, delta) {
  rawText += delta;
  el.innerHTML = renderMarkdown(rawText);
  scrollToBottom();
}

function finalizeMessage(el) {
  el.innerHTML = renderMarkdown(rawText);
  rawText = "";
  scrollToBottom();
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

connect();
