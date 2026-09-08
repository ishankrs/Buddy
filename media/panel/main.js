(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const emptyEl = document.getElementById('empty-state');
  const progressEl = document.getElementById('progress');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const clearBtn = document.getElementById('clear');
  const modeEl = document.getElementById('mode');
  const providerEl = document.getElementById('provider');
  const modelPill = document.getElementById('model-pill');
  const statusTextEl = document.getElementById('status-text');
  const statusDotEl = document.getElementById('status-dot');

  let assistantBody = null;
  let assistantText = '';
  let busy = false;
  let syncingConfig = false;
  let currentSummary = '';

  /* ---------------- markdown ---------------- */

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Inline markup on already-escaped text: code, links, bold, italic.
  function renderInline(text) {
    const codes = [];
    let out = text.replace(/`([^`\n]+)`/g, (m, code) => {
      codes.push('<code>' + code + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^~\w])~~([^~\n]+)~~/g, '$1<del>$2</del>');
    out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
    return out;
  }

  function renderMarkdown(text) {
    const lines = escapeHtml(text).split('\n');
    let html = '';
    let i = 0;
    let inCode = false;
    let codeLang = '';
    let codeBuf = [];
    let listTag = null;

    function closeList() {
      if (listTag) {
        html += '</' + listTag + '>';
        listTag = null;
      }
    }

    function closeCode() {
      const label = codeLang || 'code';
      html +=
        '<div class="codeblock"><div class="codeblock-header"><span class="lang">' +
        label +
        '</span><button class="copy-btn" type="button" data-copy>⧉ Copy</button></div>' +
        '<pre><code data-code>' +
        codeBuf.join('\n') +
        '</code></pre></div>';
      codeBuf = [];
      inCode = false;
      codeLang = '';
    }

    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^```(\S*)\s*$/);

      if (fence) {
        if (inCode) {
          closeCode();
        } else {
          closeList();
          inCode = true;
          codeLang = fence[1];
        }
        i++;
        continue;
      }

      if (inCode) {
        codeBuf.push(line);
        i++;
        continue;
      }

      if (/^\s*$/.test(line)) {
        closeList();
        i++;
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        html += '<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>';
        i++;
        continue;
      }

      if (/^---+\s*$/.test(line)) {
        closeList();
        html += '<hr/>';
        i++;
        continue;
      }

      const quote = line.match(/^&gt;\s?(.*)$/);
      if (quote) {
        closeList();
        const parts = [quote[1]];
        i++;
        while (i < lines.length) {
          const next = lines[i].match(/^&gt;\s?(.*)$/);
          if (!next) break;
          parts.push(next[1]);
          i++;
        }
        html += '<blockquote>' + parts.map(renderInline).join('<br/>') + '</blockquote>';
        continue;
      }

      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const tag = ul ? 'ul' : 'ol';
        if (listTag !== tag) {
          closeList();
          html += '<' + tag + '>';
          listTag = tag;
        }
        html += '<li>' + renderInline((ul || ol)[1]) + '</li>';
        i++;
        continue;
      }

      closeList();
      // Collect a paragraph until blank / block start.
      const parts = [line];
      i++;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^(#{1,4}\s|---+\s*$|&gt;)/.test(lines[i]) &&
        !/^\s*([-*+]\s+\S|\d+[.)]\s+\S)/.test(lines[i])
      ) {
        parts.push(lines[i]);
        i++;
      }
      html += '<p>' + parts.map(renderInline).join('<br/>') + '</p>';
    }

    closeList();
    if (inCode) {
      closeCode(); // unclosed fence while streaming — render anyway
    }
    return html;
  }

  /* ---------------- dom helpers ---------------- */

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideEmpty() {
    if (emptyEl) {
      emptyEl.style.display = 'none';
    }
  }

  function setBusy(value) {
    busy = value;
    inputEl.disabled = value;
    sendBtn.classList.toggle('stop', value);
    sendBtn.innerHTML = value ? '■' : '↑';
    sendBtn.title = value ? 'Stop' : 'Send';
    sendBtn.disabled = false;
    providerEl.disabled = value;
    modelPill.disabled = value;
    modeEl.disabled = value;
    statusDotEl.classList.toggle('busy', value);
    progressEl.classList.toggle('hidden', !value && !progressEl.textContent);
    if (value) {
      hideEmpty();
    }
  }

  function appendRow(kind) {
    const row = document.createElement('div');
    row.className = 'row ' + kind;
    messagesEl.appendChild(row);
    hideEmpty();
    scrollToBottom();
    return row;
  }

  function startAssistant() {
    assistantText = '';
    const row = appendRow('assistant');
    assistantBody = document.createElement('div');
    assistantBody.className = 'prose';
    row.appendChild(assistantBody);
  }

  function renderAssistant() {
    if (!assistantBody) {
      startAssistant();
    }
    assistantBody.innerHTML =
      renderMarkdown(assistantText) + (busy ? '<span class="caret"></span>' : '');
    scrollToBottom();
  }

  function appendAssistantChunk(text) {
    assistantText += text;
    renderAssistant();
  }

  function appendThinking(text) {
    const row = appendRow('assistant');
    const details = document.createElement('details');
    details.className = 'think';
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking';
    const body = document.createElement('div');
    body.className = 'think-body';
    body.textContent = text;
    details.appendChild(summary);
    details.appendChild(body);
    row.appendChild(details);
  }

  function isToolActivity(text) {
    return /^(🔧|✓|✗|Thinking:|Running tool:|🔍)/.test(text.trim());
  }

  function appendActivity(text) {
    const clean = text.trim();
    let icon = '•';
    let cls = '';
    if (/^🔧/.test(clean)) {
      icon = '⟳';
    } else if (/^✓/.test(clean)) {
      icon = '✓';
      cls = 'done';
    } else if (/^✗/.test(clean)) {
      icon = '✗';
      cls = 'failed';
    } else if (/^Thinking:/.test(clean)) {
      icon = '◌';
    }
    const row = appendRow('assistant');
    const el = document.createElement('div');
    el.className = ('activity ' + cls).trim();
    const iconEl = document.createElement('span');
    iconEl.className = 'icon';
    iconEl.textContent = icon;
    const textEl = document.createElement('span');
    textEl.className = 'text';
    textEl.textContent = clean.replace(/^[🔧✓✗🔍]\s*/u, '');
    el.appendChild(iconEl);
    el.appendChild(textEl);
    row.appendChild(el);
  }

  function appendError(text) {
    const row = appendRow('error');
    const box = document.createElement('div');
    box.className = 'error-box';
    box.textContent = text;
    row.appendChild(box);
  }

  /* ---------------- config ---------------- */

  function fillProviders(providers, selectedId) {
    providerEl.innerHTML = '';
    for (const p of providers) {
      const el = document.createElement('option');
      el.value = p.id;
      el.textContent = p.label;
      if (p.id === selectedId) {
        el.selected = true;
      }
      providerEl.appendChild(el);
    }
  }

  function applyLlmConfig(config) {
    syncingConfig = true;
    fillProviders(config.providers || [], config.providerId);
    currentSummary = config.summary || '';
    statusTextEl.textContent = config.modelsError
      ? '⚠ ' + config.modelsError
      : currentSummary;
    statusTextEl.title = currentSummary;
    const label = config.model || 'Select model';
    modelPill.textContent = '◇ ' + label;
    modelPill.title = config.modelsError || ('Model: ' + label + ' — click to change');
    syncingConfig = false;
  }

  /* ---------------- messaging ---------------- */

  function sendMessage() {
    if (busy) {
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    const text = inputEl.value.trim();
    if (!text) {
      return;
    }
    inputEl.value = '';
    autoResize();
    setBusy(true);
    setStatus('Buddy is working…');
    vscode.postMessage({
      type: 'send',
      message: text,
      mode: modeEl.value || undefined,
    });
  }

  function setStatus(text) {
    progressEl.textContent = text;
    progressEl.classList.toggle('hidden', !text);
  }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  }

  providerEl.addEventListener('change', () => {
    if (syncingConfig) {
      return;
    }
    vscode.postMessage({ type: 'setProvider', providerId: providerEl.value });
  });

  modelPill.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickModel' });
  });

  sendBtn.addEventListener('click', sendMessage);
  clearBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'clear' });
  });

  inputEl.addEventListener('input', autoResize);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) {
      return;
    }
    const code = btn.closest('.codeblock').querySelector('[data-code]');
    const text = code ? code.textContent : '';
    const done = () => {
      btn.textContent = '✓ Copied';
      setTimeout(() => {
        btn.textContent = '⧉ Copy';
      }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  });

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      /* clipboard unavailable */
    }
    document.body.removeChild(ta);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'llmConfig':
        applyLlmConfig(msg.config);
        break;
      case 'userMessage': {
        const row = appendRow('user');
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = msg.text;
        row.appendChild(bubble);
        startAssistant();
        break;
      }
      case 'assistantChunk':
        appendAssistantChunk(msg.text);
        break;
      case 'assistantThinking':
        appendThinking(msg.text);
        break;
      case 'progress':
        if (isToolActivity(msg.text)) {
          appendActivity(msg.text);
        } else {
          setStatus(msg.text);
        }
        break;
      case 'assistantDone':
        assistantBody = null;
        setBusy(false);
        setStatus('');
        break;
      case 'error':
        appendError(msg.text);
        assistantBody = null;
        setBusy(false);
        setStatus('');
        break;
      case 'cleared':
        messagesEl.innerHTML = '';
        messagesEl.appendChild(emptyEl);
        emptyEl.style.display = '';
        assistantBody = null;
        assistantText = '';
        setBusy(false);
        setStatus('');
        break;
    }
  });

  autoResize();
  vscode.postMessage({ type: 'ready' });
})();
