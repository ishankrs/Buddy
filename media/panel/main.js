(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const progressEl = document.getElementById('progress');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const clearBtn = document.getElementById('clear');
  const modeEl = document.getElementById('mode');
  const providerEl = document.getElementById('provider');
  const modelEl = document.getElementById('model');
  const providerSummaryEl = document.getElementById('provider-summary');
  const pickProviderModelBtn = document.getElementById('pick-provider-model');
  const pickModelBtn = document.getElementById('pick-model');

  let assistantEl = null;
  let assistantText = '';
  let busy = false;
  let syncingConfig = false;

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    inputEl.disabled = value;
    progressEl.classList.toggle('hidden', !value);
  }

  function appendMessage(className, html) {
    const el = document.createElement('div');
    el.className = `message ${className}`;
    el.innerHTML = html;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderMarkdownLite(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br/>');
  }

  function startAssistant() {
    assistantText = '';
    assistantEl = appendMessage('assistant', '');
  }

  function appendAssistantChunk(text) {
    if (!assistantEl) {
      startAssistant();
    }
    assistantText += text;
    assistantEl.innerHTML = renderMarkdownLite(assistantText);
    scrollToBottom();
  }

  function fillSelect(selectEl, options, selectedValue) {
    selectEl.innerHTML = '';
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      if (option.value === selectedValue) {
        el.selected = true;
      }
      selectEl.appendChild(el);
    }
  }

  function applyLlmConfig(config) {
    syncingConfig = true;

    fillSelect(
      providerEl,
      config.providers.map((p) => ({ value: p.id, label: p.label })),
      config.providerId
    );

    const modelOptions = config.models.map((model) => ({ value: model, label: model }));
    modelOptions.push({ value: '__pick__', label: 'Choose model…' });
    fillSelect(modelEl, modelOptions, config.model);

    providerSummaryEl.textContent = config.summary;

    syncingConfig = false;
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || busy) {
      return;
    }
    inputEl.value = '';
    setBusy(true);
    progressEl.textContent = 'Buddy is working…';
    vscode.postMessage({
      type: 'send',
      message: text,
      mode: modeEl.value || undefined,
    });
  }

  providerEl.addEventListener('change', () => {
    if (syncingConfig) {
      return;
    }
    vscode.postMessage({ type: 'setProvider', providerId: providerEl.value });
  });

  modelEl.addEventListener('change', () => {
    if (syncingConfig) {
      return;
    }
    if (modelEl.value === '__pick__') {
      vscode.postMessage({ type: 'pickModel' });
      return;
    }
    vscode.postMessage({ type: 'setModel', model: modelEl.value });
  });

  pickProviderModelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickProviderModel' });
  });

  pickModelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickModel' });
  });

  sendBtn.addEventListener('click', sendMessage);
  clearBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'clear' });
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'llmConfig':
        applyLlmConfig(msg.config);
        break;
      case 'userMessage':
        appendMessage('user', renderMarkdownLite(msg.text));
        startAssistant();
        break;
      case 'assistantChunk':
        appendAssistantChunk(msg.text);
        break;
      case 'assistantThinking':
        appendMessage(
          'thinking',
          `<details open><summary>Thinking</summary>${renderMarkdownLite(msg.text)}</details>`
        );
        break;
      case 'progress':
        progressEl.textContent = msg.text;
        progressEl.classList.remove('hidden');
        break;
      case 'assistantDone':
        assistantEl = null;
        setBusy(false);
        progressEl.classList.add('hidden');
        break;
      case 'error':
        appendMessage('error', renderMarkdownLite(msg.text));
        setBusy(false);
        progressEl.classList.add('hidden');
        break;
      case 'cleared':
        messagesEl.innerHTML = '';
        assistantEl = null;
        assistantText = '';
        setBusy(false);
        progressEl.classList.add('hidden');
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
