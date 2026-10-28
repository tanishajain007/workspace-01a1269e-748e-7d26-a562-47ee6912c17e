/**
 * app.js — UI layer: state, rendering, events.
 *
 * All API reasoning lives in js/gemini.js and js/config.js; this file only
 * touches the DOM and localStorage.
 */
(function () {
  'use strict';

  const CFG = window.AppConfig;
  const G = window.Gemini;
  const MD = window.Markdown;
  const K = CFG.STORAGE_KEYS;

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const on = (node, type, fn, opts) => node && node.addEventListener(type, fn, opts);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v; // only ever pre-sanitised markdown
      else if (k.startsWith('data-')) node.setAttribute(k, v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) if (c) node.appendChild(c);
    return node;
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  function readStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      console.warn('localStorage read failed', key, err);
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      toast('Could not save to localStorage (quota full?). Export your chats.', 'error', 6000);
      console.warn('localStorage write failed', key, err);
      return false;
    }
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  // ---------------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------------
  const state = {
    settings: Object.assign({}, CFG.DEFAULT_SETTINGS),
    chats: [],
    activeId: null,
    attachments: [],
    liveModels: null,
    proxyAvailable: false,
    keySource: 'none', // 'settings' | 'env' | 'proxy' | 'none'
    envKey: '',
    session: { requests: 0, promptTokens: 0, outputTokens: 0 },
    stream: null, // { controller, messageId }
  };

  let guard = null;

  function activeChat() {
    return state.chats.find((c) => c.id === state.activeId) || null;
  }

  function newChat(activate = true) {
    const chat = { id: uid(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    state.chats.unshift(chat);
    if (activate) state.activeId = chat.id;
    persistChats();
    renderChatList();
    if (activate) renderActiveChat();
    return chat;
  }

  const persistChats = debounce(() => {
    if (!state.settings.rememberAcrossReloads) return;
    writeStorage(K.chats, state.chats.slice(0, 60));
    writeStorage(K.activeChat, state.activeId);
    renderDataStats();
  }, 250);

  const persistSettings = debounce(() => writeStorage(K.settings, state.settings), 250);

  // ---------------------------------------------------------------------------
  // toasts
  // ---------------------------------------------------------------------------
  function toast(message, tone = 'info', ms = 4200) {
    const box = $('toasts');
    const node = el('div', { class: `toast toast-${tone}`, role: 'status' }, [
      el('span', { class: 'toast-text', text: message }),
      el('button', { class: 'toast-close', 'aria-label': 'Dismiss', html: '<svg class="icon"><use href="#i-close"/></svg>' }),
    ]);
    box.appendChild(node);
    const close = () => { node.classList.add('out'); setTimeout(() => node.remove(), 220); };
    node.querySelector('.toast-close').addEventListener('click', close);
    setTimeout(close, ms);
    return node;
  }

  // ---------------------------------------------------------------------------
  // model list
  // ---------------------------------------------------------------------------
  function modelOptions() {
    const base = state.liveModels && state.liveModels.length ? state.liveModels : CFG.MODELS;
    return base;
  }

  function findModel(id) {
    return modelOptions().find((m) => m.id === id) || CFG.MODELS.find((m) => m.id === id) || null;
  }

  function populateModelSelects() {
    const models = modelOptions();
    for (const select of [$('model-select'), $('set-model')]) {
      if (!select) continue;
      const current = select.value || state.settings.model;
      select.innerHTML = '';
      for (const m of models) {
        const opt = el('option', { value: m.id });
        opt.textContent = `${m.label}${m.tier ? ` · ${m.tier}` : ''}`;
        select.appendChild(opt);
      }
      if (models.some((m) => m.id === current)) select.value = current;
      else select.value = state.settings.model;
    }
    syncModelMeta();
  }

  function syncModelMeta() {
    const m = findModel(state.settings.model);
    $('model-badge').textContent = state.settings.model;
    $('tier-badge').textContent = m && m.tier ? m.tier.toLowerCase() : 'unknown tier';
    $('tier-badge').classList.toggle('is-paid', Boolean(m && m.tier && !/free/i.test(m.tier)));
    const note = $('model-note');
    if (note) {
      const limits = m && m.inputLimit ? ` · ${fmtNum(m.inputLimit)} in / ${fmtNum(m.outputLimit)} out` : '';
      note.textContent = `${(m && m.note) || ''}${limits}`;
    }
    const thinking = $('set-thinking');
    if (thinking) {
      const supported = Boolean(m && m.thinking);
      thinking.disabled = !supported;
      if (!supported && state.settings.thinkingLevel !== 'off') {
        state.settings.thinkingLevel = 'off';
        thinking.value = 'off';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // key handling (.env, localStorage, proxy)
  // ---------------------------------------------------------------------------
  async function loadEnvFile() {
    try {
      const res = await fetch('.env', { cache: 'no-store' });
      if (!res.ok) return null;
      const text = await res.text();
      if (/^\s*<(!doctype|html)/i.test(text)) return null; // static server HTML fallback
      return G.parseEnv(text);
    } catch (err) {
      console.info('.env not readable (file:// or not served):', String(err && err.message));
      return null;
    }
  }

  async function probeProxy() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (!res.ok) return false;
      const json = await res.json();
      return Boolean(json && json.ok);
    } catch (_) {
      return false;
    }
  }

  /** The key that will actually be used for the next request (may be empty in proxy mode). */
  function effectiveKey() {
    if (state.settings.apiKey) return state.settings.apiKey;
    if (state.envKey && !G.isPlaceholderKey(state.envKey)) return state.envKey;
    return '';
  }

  function usingProxy() {
    const mode = state.settings.requestMode;
    if (mode === 'proxy') return state.proxyAvailable;
    if (mode === 'browser') return false;
    return state.proxyAvailable && !effectiveKey();
  }

  function updateKeyBadge() {
    const badge = $('key-badge');
    const source = $('key-source');
    if (state.settings.apiKey) {
      state.keySource = 'settings';
      badge.textContent = 'key: saved';
    } else if (state.envKey && !G.isPlaceholderKey(state.envKey)) {
      state.keySource = 'env';
      badge.textContent = 'key: .env';
    } else if (state.proxyAvailable) {
      state.keySource = 'proxy';
      badge.textContent = 'key: proxy';
    } else {
      state.keySource = 'none';
      badge.textContent = 'no key';
    }
    badge.classList.toggle('is-bad', state.keySource === 'none');
    if (source) {
      source.textContent =
        state.keySource === 'settings' ? 'Loaded from this browser (localStorage).' :
        state.keySource === 'env' ? 'Loaded from .env (GEMINI_API_KEY).' :
        state.keySource === 'proxy' ? 'Held by server.mjs — the browser never sees it.' :
        'No key found. Edit .env (GEMINI_API_KEY=…) or paste one here.';
    }
    $('mode-badge').textContent = usingProxy() ? 'proxy' : 'direct';
    // Keep the settings form in step whenever the key source changes.
    const keyInput = $('set-api-key');
    if (keyInput && !document.getElementById('settings-modal').open) {
      keyInput.value = state.settings.apiKey || '';
      keyInput.placeholder = state.keySource === 'env'
        ? 'Loaded from .env — leave empty to keep using it'
        : 'AIza…';
    }
  }

  function baseForRequests() {
    return usingProxy() ? '/api/gemini/v1beta' : CFG.API_BASE;
  }

  async function ensureUsableKey() {
    if (usingProxy()) return true;
    if (effectiveKey()) return true;
    toast('No API key yet — open Settings → Connection, or add GEMINI_API_KEY to .env', 'error', 7000);
    openSettings('connection');
    return false;
  }

  // ---------------------------------------------------------------------------
  // rendering: chat list
  // ---------------------------------------------------------------------------
  function renderChatList() {
    const list = $('chat-list');
    const q = ($('chat-search').value || '').trim().toLowerCase();
    list.innerHTML = '';

    const chats = state.chats.filter((c) => {
      if (!q) return true;
      if (c.title.toLowerCase().includes(q)) return true;
      return c.messages.some((m) => (m.text || '').toLowerCase().includes(q));
    });

    if (!chats.length) {
      list.appendChild(el('p', { class: 'empty-note', text: q ? 'No chat matches that search.' : 'No conversations yet.' }));
      return;
    }

    for (const chat of chats) {
      const preview = chat.messages.length
        ? MD.toPlainText(chat.messages[chat.messages.length - 1].text || '').slice(0, 70)
        : 'Empty chat';
      const item = el('div', {
        class: 'chat-item' + (chat.id === state.activeId ? ' is-active' : ''),
        role: 'button',
        tabindex: '0',
        'data-id': chat.id,
      }, [
        el('div', { class: 'chat-item-main' }, [
          el('span', { class: 'chat-item-title', text: chat.title }),
          el('span', { class: 'chat-item-preview', text: preview }),
        ]),
        el('button', { class: 'chat-item-del', 'aria-label': 'Delete chat', title: 'Delete chat',
          html: '<svg class="icon"><use href="#i-trash"/></svg>' }),
      ]);
      item.addEventListener('click', (e) => {
        if (e.target.closest('.chat-item-del')) return;
        switchChat(chat.id);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchChat(chat.id); }
      });
      item.querySelector('.chat-item-del').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(chat.id);
      });
      list.appendChild(item);
    }
  }

  function switchChat(id) {
    if (state.stream) stopStreaming();
    state.activeId = id;
    writeStorage(K.activeChat, id);
    renderChatList();
    renderActiveChat();
    closeSidebar();
  }

  function deleteChat(id) {
    const chat = state.chats.find((c) => c.id === id);
    if (!chat) return;
    if (!confirm(`Delete "${chat.title}"? This cannot be undone.`)) return;
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.activeId === id) {
      state.activeId = state.chats.length ? state.chats[0].id : newChat(false).id;
    }
    persistChats();
    renderChatList();
    renderActiveChat();
  }

  // ---------------------------------------------------------------------------
  // rendering: messages
  // ---------------------------------------------------------------------------
  const pendingRenders = new Map();

  function scheduleRender(messageId) {
    if (pendingRenders.has(messageId)) return;
    pendingRenders.set(messageId, requestAnimationFrame(() => {
      pendingRenders.delete(messageId);
      const chat = activeChat();
      const msg = chat && chat.messages.find((m) => m.id === messageId);
      const node = document.querySelector(`[data-msg="${messageId}"] .msg-body`);
      if (msg && node) node.innerHTML = MD.render(msg.text || '');
      maybeAutoScroll();
    }));
  }

  function buildActions(msg, isLastModel) {
    const wrap = el('div', { class: 'msg-actions' });
    const mk = (label, icon, fn) => {
      const b = el('button', { class: 'msg-action', title: label, 'aria-label': label,
        html: `<svg class="icon"><use href="#i-${icon}"/></svg>` });
      b.addEventListener('click', fn);
      wrap.appendChild(b);
    };
    mk('Copy', 'copy', async () => {
      try {
        await navigator.clipboard.writeText(msg.text || '');
        toast('Copied to clipboard', 'ok', 1800);
      } catch (_) { toast('Clipboard blocked by the browser', 'error'); }
    });
    if (msg.role === 'user') {
      mk('Edit & resend', 'edit', () => editAndResend(msg.id));
    } else {
      mk('Delete', 'trash', () => deleteMessage(msg.id));
      if (isLastModel) {
        mk('Regenerate', 'refresh', () => regenerate());
        if (msg.finishReason === 'MAX_TOKENS') mk('Continue', 'continue', () => continueLast());
        if (msg.error) mk('Retry', 'refresh', () => regenerate());
      }
    }
    if (msg.role === 'user') mk('Delete', 'trash', () => deleteMessage(msg.id));
    return wrap;
  }

  function messageElement(msg, isLastModel) {
    const body = el('div', { class: 'msg-body md' });
    body.innerHTML = MD.render(msg.text || '');

    const images = (msg.images || []).length
      ? el('div', { class: 'msg-images' }, (msg.images || []).map((img) => {
          const imgEl = el('img', { src: `data:${img.mimeType};base64,${img.data}`, alt: 'Attached image' });
          return el('figure', { class: 'msg-image' }, [imgEl]);
        }))
      : null;

    const meta = [];
    if (msg.thought && state.settings.showThinking) {
      const details = el('details', { class: 'thought' }, [
        el('summary', { text: `Thinking (${msg.thought.length.toLocaleString()} chars)` }),
        el('div', { class: 'thought-body md', html: MD.render(msg.thought) }),
      ]);
      meta.push(details);
    }
    if (msg.finishReason) {
      const d = G.describeFinishReason(msg.finishReason);
      if (d && msg.finishReason !== 'STOP') {
        meta.push(el('div', { class: `finish finish-${d.tone}`, text: `${d.label}${d.note ? ` — ${d.note}` : ''}` }));
      }
    }
    if (msg.role === 'model' && state.settings.showTokenStats && msg.usage) {
      const u = msg.usage;
      meta.push(el('div', { class: 'usage', text:
        `${fmtNum(u.promptTokenCount)} in · ${fmtNum(u.candidatesTokenCount)} out` +
        (u.thoughtsTokenCount ? ` · ${fmtNum(u.thoughtsTokenCount)} thought` : '') +
        (u.cachedContentTokenCount ? ` · ${fmtNum(u.cachedContentTokenCount)} cached` : '') +
        (msg.latencyMs ? ` · ${(msg.latencyMs / 1000).toFixed(1)}s` : '') +
        (msg.model ? ` · ${msg.model}` : '') }));
    }
    if (msg.citations && msg.citations.length) {
      meta.push(el('div', { class: 'citations' }, [
        el('span', { text: 'Sources: ' }),
        ...msg.citations.slice(0, 6).map((u) => el('a', { href: u, target: '_blank', rel: 'noopener noreferrer', text: new URL(u).hostname })),
      ]));
    }

    const node = el('article', {
      class: `msg msg-${msg.role}` + (msg.pending ? ' is-pending' : '') + (msg.error ? ' is-error' : ''),
      'data-msg': msg.id,
    }, [
      el('div', { class: 'msg-avatar', 'aria-hidden': 'true',
        html: msg.role === 'user' ? 'You' : '<svg class="icon"><use href="#i-spark"/></svg>' }),
      el('div', { class: 'msg-content' }, [
        images,
        body,
        msg.error ? el('div', { class: 'msg-error', role: 'alert', text: msg.error }) : null,
        meta.length ? el('div', { class: 'msg-meta' }, meta) : null,
        msg.pending ? el('div', { class: 'typing', html: '<i></i><i></i><i></i>' }) : null,
        buildActions(msg, isLastModel),
      ]),
    ]);
    return node;
  }

  function renderActiveChat() {
    const box = $('messages');
    box.innerHTML = '';
    const chat = activeChat();
    $('chat-title').textContent = chat ? chat.title : 'New chat';

    if (!chat || !chat.messages.length) {
      box.appendChild(emptyState());
    } else {
      const lastModelId = [...chat.messages].reverse().find((m) => m.role === 'model' && !m.pending);
      for (const msg of chat.messages) {
        box.appendChild(messageElement(msg, lastModelId && msg.id === lastModelId.id));
      }
    }
    updateTurnStat();
    scrollToBottom(true);
  }

  function emptyState() {
    const wrap = el('div', { class: 'empty' });
    wrap.appendChild(el('div', { class: 'empty-mark', html: '<svg class="icon"><use href="#i-spark"/></svg>' }));
    wrap.appendChild(el('h2', { text: 'What can I help with?' }));
    wrap.appendChild(el('p', { class: 'empty-sub',
      text: `Talking to ${state.settings.model} on the Gemini API free tier. Responses stream in as they are generated.` }));
    const ideas = [
      'Explain how the Gemini API rate limits work on the free tier.',
      'Write a debounce function in JavaScript and explain every line.',
      'Give me a 7-day plan to learn CSS Grid, 20 minutes a day.',
      'Turn this idea into a short spec: ',
    ];
    const row = el('div', { class: 'ideas' }, ideas.map((text) => {
      const b = el('button', { class: 'idea', type: 'button' }, [el('span', { text })]);
      b.addEventListener('click', () => {
        $('composer-input').value = text;
        autoGrow($('composer-input'));
        $('composer-input').focus();
      });
      return b;
    }));
    wrap.appendChild(row);
    if (!effectiveKey() && !usingProxy()) {
      const cta = el('button', { class: 'btn btn-primary empty-cta', html:
        '<svg class="icon"><use href="#i-settings"/></svg> Add your API key' });
      cta.addEventListener('click', () => openSettings('connection'));
      wrap.appendChild(cta);
    }
    return wrap;
  }

  function updateTurnStat() {
    const chat = activeChat();
    const turns = chat ? chat.messages.length : 0;
    $('turn-stat').textContent = turns ? `${turns} message${turns === 1 ? '' : 's'} · ctx ≈ ${fmtNum(estimateContextTokens())} tokens` : '';
  }

  function estimateContextTokens() {
    const chat = activeChat();
    if (!chat) return 0;
    return G.trimContext(G.messagesToContents(chat.messages), {
      tokenBudget: state.settings.contextTokenBudget, alwaysKeep: 2,
    }).estimatedTokens;
  }

  // ---------------------------------------------------------------------------
  // scroll handling
  // ---------------------------------------------------------------------------
  let stickToBottom = true;

  function scrollToBottom(force) {
    const wrap = $('messages-wrap');
    if (!wrap || (!force && !stickToBottom)) return;
    // Element.scrollTo is missing on some older browsers (Safari < 14).
    if (typeof wrap.scrollTo === 'function') {
      wrap.scrollTo({ top: wrap.scrollHeight, behavior: force ? 'auto' : 'smooth' });
    } else {
      wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function maybeAutoScroll() {
    scrollToBottom(false);
  }

  function wireScroll() {
    const wrap = $('messages-wrap');
    on(wrap, 'scroll', () => {
      const distance = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
      stickToBottom = distance < 80;
      $('scroll-bottom').hidden = stickToBottom;
    });
    on($('scroll-bottom'), 'click', () => { stickToBottom = true; scrollToBottom(true); });
  }

  // ---------------------------------------------------------------------------
  // composer + attachments
  // ---------------------------------------------------------------------------
  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 220) + 'px';
  }

  async function addImageFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('Only image files are supported here', 'error'); return; }
    if (file.size > 8 * 1024 * 1024) { toast('Image is larger than 8 MB', 'error'); return; }
    if (state.attachments.length >= 4) { toast('Maximum 4 images per message', 'error'); return; }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    const compressed = await downscale(dataUrl, 1568);
    state.attachments.push(compressed);
    renderAttachments();
  }

  /** Downscale + re-encode so we don't blow up the request size or TPM quota. */
  function downscale(dataUrl, maxEdge) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        if (scale >= 1 && dataUrl.length < 400000) {
          const [meta, b64] = dataUrl.split(',');
          resolve({ mimeType: (meta.match(/data:(.*?);/) || [])[1] || 'image/png', data: b64, preview: dataUrl });
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL('image/jpeg', 0.85);
        const [meta, b64] = out.split(',');
        resolve({ mimeType: (meta.match(/data:(.*?);/) || [])[1] || 'image/jpeg', data: b64, preview: out });
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  function renderAttachments() {
    const box = $('attachments');
    box.innerHTML = '';
    if (!state.attachments.length) { box.hidden = true; return; }
    box.hidden = false;
    state.attachments.forEach((img, i) => {
      const chip = el('div', { class: 'attachment' }, [
        el('img', { src: img.preview || `data:${img.mimeType};base64,${img.data}`, alt: '' }),
        el('button', { class: 'attachment-del', 'aria-label': 'Remove image',
          html: '<svg class="icon"><use href="#i-close"/></svg>' }),
      ]);
      chip.querySelector('.attachment-del').addEventListener('click', () => {
        state.attachments.splice(i, 1);
        renderAttachments();
      });
      box.appendChild(chip);
    });
  }

  // ---------------------------------------------------------------------------
  // sending
  // ---------------------------------------------------------------------------
  function buildRequestContents(chat) {
    const contents = G.messagesToContents(chat.messages);
    return G.trimContext(contents, {
      tokenBudget: state.settings.contextTokenBudget,
      alwaysKeep: 2,
    });
  }

  async function sendMessage(textOverride, imageOverride) {
    if (state.stream) { toast('Still generating — press Stop first', 'info', 2500); return; }
    const input = $('composer-input');
    const text = (textOverride !== undefined ? textOverride : input.value).trim();
    const images = imageOverride || state.attachments.slice();

    if (!text && !images.length) return;
    if (!(await ensureUsableKey())) return;

    let chat = activeChat();
    if (!chat) chat = newChat();

    chat.messages.push({
      id: uid(), role: 'user', text, images, ts: Date.now(),
    });
    if (chat.messages.length === 1 && text) {
      chat.title = text.length > 44 ? text.slice(0, 44) + '…' : text;
      $('chat-title').textContent = chat.title;
      renderChatList();
    }
    chat.updatedAt = Date.now();

    if (textOverride === undefined) input.value = '';
    state.attachments = [];
    renderAttachments();
    autoGrow(input);
    persistChats();
    renderActiveChat();

    const modelMsg = { id: uid(), role: 'model', text: '', thought: '', pending: true, ts: Date.now(), model: state.settings.model };
    chat.messages.push(modelMsg);
    renderActiveChat();
    setBusy(true);

    // --- free-tier guard -----------------------------------------------------
    if (guard) {
      const check = guard.check();
      if (!check.ok) {
        if (check.reason === 'rpd') {
          failMessage(modelMsg, { title: 'Daily request budget reached',
            hint: 'Your client-side RPD guard says stop. Raise it in Settings → Quota, or wait for the Pacific-midnight reset.' });
          setBusy(false);
          return;
        }
        const waitSec = Math.ceil(check.waitMs / 1000);
        toast(`Quota guard: waiting ${waitSec}s (${check.reason.toUpperCase()})`, 'info', Math.min(waitSec * 1000, 8000));
        try { await G.sleep(Math.min(check.waitMs, 60000), state.stream && state.stream.controller.signal); }
        catch (_) { /* aborted */ }
      }
    }

    const controller = new AbortController();
    state.stream = { controller, messageId: modelMsg.id };

    const trimmed = buildRequestContents(chat);
    if (trimmed.dropped > 0) {
      console.info(`Trimmed ${trimmed.dropped} older message(s) from the request to fit the context budget.`);
    }
    const body = G.buildRequestBody({
      contents: trimmed.contents,
      systemInstruction: state.settings.systemInstruction,
      settings: state.settings,
      supportsThinking: Boolean((findModel(state.settings.model) || {}).thinking),
    });

    if (guard) guard.record();
    renderQuota();

    try {
      const result = await G.generate({
        model: state.settings.model,
        body,
        apiKey: usingProxy() ? 'proxy' : effectiveKey(),
        stream: state.settings.streaming,
        signal: controller.signal,
        base: baseForRequests(),
        timeoutMs: state.settings.timeoutMs,
        maxRetries: state.settings.maxRetries,
        onRetry: ({ attempt, waitMs, error }) =>
          toast(`Retry ${attempt} in ${(waitMs / 1000).toFixed(1)}s — ${error.title}`, 'info', 3200),
        onDelta: (full) => {
          modelMsg.text = full;
          modelMsg.pending = false;
          ensureBodyNode(modelMsg.id);
          scheduleRender(modelMsg.id);
          setTyping(false);
        },
        onThought: (full) => {
          modelMsg.thought = full;
          setThinking(true);
        },
      });

      modelMsg.pending = false;
      modelMsg.text = result.text || modelMsg.text;
      modelMsg.thought = result.thought || modelMsg.thought;
      modelMsg.finishReason = result.finishReason;
      modelMsg.usage = result.usage;
      modelMsg.latencyMs = result.latencyMs;
      modelMsg.citations = result.citations;
      modelMsg.model = state.settings.model;

      if (result.blocked) {
        modelMsg.error = `Prompt blocked before generation: ${result.blocked.reason}${result.blocked.message ? ` — ${result.blocked.message}` : ''}`;
      } else if (!modelMsg.text) {
        modelMsg.finishReason = modelMsg.finishReason || 'STOP';
        modelMsg.text = '_(The model returned no text.)_';
      }

      if (result.usage) {
        state.session.requests += 1;
        state.session.promptTokens += result.usage.promptTokenCount || 0;
        state.session.outputTokens += (result.usage.candidatesTokenCount || 0) + (result.usage.thoughtsTokenCount || 0);
      }
      writeStorage(K.usage, state.session);
    } catch (err) {
      modelMsg.pending = false;
      setTyping(false);
      if (err && err.name === 'AbortError') {
        modelMsg.text = modelMsg.text ? modelMsg.text + '\n\n_[stopped]_' : '_[stopped by you]_';
        modelMsg.finishReason = null;
      } else {
        const apiErr = err && err.apiError;
        modelMsg.error = apiErr ? `${apiErr.title}: ${apiErr.raw}` : `Request failed: ${String(err && err.message)}`;
        if (apiErr) {
          if (apiErr.status === 429) toast(apiErr.title + ' — ' + apiErr.hint, 'error', 8000);
          else if (apiErr.status === 404) toast(apiErr.title + ' — ' + apiErr.hint, 'error', 8000);
        }
      }
    } finally {
      state.stream = null;
      setBusy(false);
      setThinking(false);
      chat.updatedAt = Date.now();
      persistChats();
      renderActiveChat();
      renderDataStats();
    }
  }

  function ensureBodyNode(id) {
    if (document.querySelector(`[data-msg="${id}"] .msg-body`)) return;
    renderActiveChat();
  }

  function failMessage(msg, apiErr) {
    msg.pending = false;
    msg.error = `${apiErr.title}: ${apiErr.hint}`;
    persistChats();
    renderActiveChat();
  }

  function setBusy(busy) {
    $('send-btn').hidden = busy;
    $('stop-btn').hidden = !busy;
    $('composer-input').disabled = false;
    $('composer-hint').textContent = busy
      ? 'Generating… Esc to stop.'
      : 'Answers can be wrong. Verify anything important.';
    if (!busy) $('composer-input').focus();
  }

  function setTyping(on_) {
    const chat = activeChat();
    if (!chat || !state.stream) return;
    const node = document.querySelector(`[data-msg="${state.stream.messageId}"] .typing`);
    if (node && on_ === false) node.remove();
  }

  function setThinking(on_) {
    if (!state.stream) return;
    const node = document.querySelector(`[data-msg="${state.stream.messageId}"] .msg-body`);
    if (!node) return;
    if (on_) node.classList.add('is-thinking');
    else node.classList.remove('is-thinking');
  }

  function stopStreaming() {
    if (!state.stream) return;
    state.stream.controller.abort();
  }

  function regenerate() {
    const chat = activeChat();
    if (!chat) return;
    let lastModelIdx = -1;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'model') { lastModelIdx = i; break; }
    }
    if (lastModelIdx === -1) return;
    chat.messages.splice(lastModelIdx, 1);
    const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user');
    persistChats();
    renderActiveChat();
    if (lastUser) sendMessage(lastUser.text, lastUser.images && lastUser.images.length
      ? lastUser.images.map((i) => ({ mimeType: i.mimeType, data: i.data }))
      : undefined);
  }

  function continueLast() {
    sendMessage('Continue exactly where you left off. Do not repeat anything already written.');
  }

  function editAndResend(id) {
    const chat = activeChat();
    if (!chat) return;
    const idx = chat.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const msg = chat.messages[idx];
    $('composer-input').value = msg.text || '';
    autoGrow($('composer-input'));
    state.attachments = (msg.images || []).map((i) => ({ ...i, preview: `data:${i.mimeType};base64,${i.data}` }));
    renderAttachments();
    chat.messages.splice(idx); // drop this turn and everything after it
    persistChats();
    renderActiveChat();
    $('composer-input').focus();
  }

  function deleteMessage(id) {
    const chat = activeChat();
    if (!chat) return;
    chat.messages = chat.messages.filter((m) => m.id !== id);
    persistChats();
    renderActiveChat();
  }

  // ---------------------------------------------------------------------------
  // settings modal
  // ---------------------------------------------------------------------------
  function openSettings(tab) {
    const modal = $('settings-modal');
    syncSettingsForm();
    if (typeof modal.showModal === 'function') {
      if (!modal.open) modal.showModal();
    } else modal.setAttribute('open', '');
    if (tab) selectTab(tab);
  }

  function selectTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
  }

  function syncSettingsForm() {
    const s = state.settings;
    // Deliberately does NOT prefill from .env: copying a server/file-provided
    // secret into a DOM input would silently persist it to localStorage the
    // next time any setting is saved. The badge shows where the key came from.
    $('set-api-key').value = s.apiKey || '';
    $('set-api-key').placeholder = state.keySource === 'env'
      ? 'Loaded from .env — leave empty to keep using it'
      : 'AIza…';
    $('set-request-mode').value = s.requestMode;
    $('set-streaming').checked = s.streaming;
    $('set-timeout').value = s.timeoutMs;
    $('set-retries').value = s.maxRetries;
    $('set-model').value = s.model;
    $('set-temperature').value = s.temperature;
    $('temperature-val').textContent = Number(s.temperature).toFixed(2);
    $('set-topp').value = s.topP;
    $('topp-val').textContent = Number(s.topP).toFixed(2);
    $('set-topk').value = s.topK;
    $('set-max-tokens').value = s.maxOutputTokens;
    $('set-stop').value = s.stopSequences;
    $('set-thinking').value = s.thinkingLevel;
    $('set-context').value = s.contextTokenBudget;
    $('set-show-thinking').checked = s.showThinking;
    $('set-show-stats').checked = s.showTokenStats;
    $('set-preset').value = s.systemPreset;
    $('set-system').value = s.systemInstruction;
    $('set-safety').value = s.safetyThreshold;
    $('set-remember').checked = s.rememberAcrossReloads;
    $('set-guard').checked = s.guardEnabled;
    $('set-rpm').value = s.guardRpm;
    $('set-rpd').value = s.guardRpd;
    $('set-interval').value = s.minIntervalMs;
    $('set-font-scale').value = s.fontScale;
    $('font-scale-val').textContent = s.fontScale + '%';
    syncModelMeta();
    renderDataStats();
  }

  function readSettingsForm() {
    const s = state.settings;
    const num = (id, fallback) => {
      const v = $(id).value;
      return v === '' || v === null ? fallback : Number(v);
    };
    s.apiKey = $('set-api-key').value.trim();
    s.requestMode = $('set-request-mode').value;
    s.streaming = $('set-streaming').checked;
    s.timeoutMs = clamp(num('set-timeout', s.timeoutMs), 5000, 600000);
    s.maxRetries = clamp(Math.round(num('set-retries', s.maxRetries)), 0, 5);
    s.model = $('set-model').value || s.model;
    s.temperature = clamp(num('set-temperature', s.temperature), 0, 2);
    s.topP = clamp(num('set-topp', s.topP), 0, 1);
    const topk = $('set-topk').value;
    s.topK = topk === '' ? '' : clamp(Math.round(Number(topk)), 1, 100);
    s.maxOutputTokens = clamp(Math.round(num('set-max-tokens', s.maxOutputTokens)), 256, 65536);
    s.stopSequences = $('set-stop').value;
    s.thinkingLevel = $('set-thinking').value;
    s.contextTokenBudget = clamp(Math.round(num('set-context', s.contextTokenBudget)), 1000, 500000);
    s.showThinking = $('set-show-thinking').checked;
    s.showTokenStats = $('set-show-stats').checked;
    s.systemPreset = $('set-preset').value;
    s.systemInstruction = $('set-system').value;
    s.safetyThreshold = $('set-safety').value;
    s.rememberAcrossReloads = $('set-remember').checked;
    s.guardEnabled = $('set-guard').checked;
    s.guardRpm = clamp(Math.round(num('set-rpm', s.guardRpm)), 0, 2000);
    s.guardRpd = clamp(Math.round(num('set-rpd', s.guardRpd)), 0, 100000);
    s.minIntervalMs = clamp(Math.round(num('set-interval', s.minIntervalMs)), 0, 60000);
    s.fontScale = clamp(Math.round(num('set-font-scale', s.fontScale)), 85, 130);
  }

  function applySettings() {
    buildGuard();
    applyTheme();
    document.documentElement.style.setProperty('--font-scale', (state.settings.fontScale / 100).toFixed(2));
    populateModelSelects();
    updateKeyBadge();
    renderQuota();
    renderActiveChat();
    renderChatList();
    persistSettings();
  }

  function buildGuard() {
    const saved = readStorage(K.usage, { requests: 0, promptTokens: 0, outputTokens: 0 });
    Object.assign(state.session, saved);
    guard = G.createRateGuard({
      enabled: state.settings.guardEnabled,
      rpm: state.settings.guardRpm,
      rpd: state.settings.guardRpd,
      minIntervalMs: state.settings.minIntervalMs,
      initialDailyCount: readStorage('geminiChat.daily.v1', { day: '', count: 0 }).count || 0,
    });
    renderQuota();
  }

  function renderQuota() {
    if (!guard) return;
    const snap = guard.snapshot();
    $('quota-rpm').textContent = `${snap.usedThisMinute} / ${snap.rpm || '∞'}`;
    $('quota-rpd').textContent = `${snap.usedToday} / ${snap.rpd || '∞'}`;
    const pct = snap.rpm ? clamp((snap.usedThisMinute / snap.rpm) * 100, 0, 100) : 0;
    $('quota-rpm-bar').style.width = pct + '%';
    $('quota-rpm-bar').classList.toggle('is-hot', pct >= 80);
    writeStorage('geminiChat.daily.v1', { day: snap.day, count: snap.usedToday });
  }

  function renderDataStats() {
    const msgs = state.chats.reduce((n, c) => n + c.messages.length, 0);
    $('stat-chats').textContent = fmtNum(state.chats.length);
    $('stat-msgs').textContent = fmtNum(msgs);
    $('stat-prompt').textContent = fmtNum(state.session.promptTokens);
    $('stat-output').textContent = fmtNum(state.session.outputTokens);
    let bytes = 0;
    try { bytes = (localStorage.getItem(K.chats) || '').length; } catch (_) {}
    $('stat-storage').textContent = bytes > 1024 ? (bytes / 1024).toFixed(0) + ' KB' : bytes + ' B';
  }

  function applyTheme() {
    const theme = state.settings.theme;
    document.documentElement.setAttribute('data-theme', theme);
    const icon = $('theme-toggle').querySelector('use');
    icon.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  }

  // ---------------------------------------------------------------------------
  // export / import
  // ---------------------------------------------------------------------------
  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportMarkdown() {
    const chat = activeChat();
    if (!chat || !chat.messages.length) { toast('Nothing to export yet', 'info'); return; }
    const lines = [`# ${chat.title}`, '', `_Model: ${state.settings.model} · Exported ${new Date().toLocaleString()}_`, ''];
    for (const m of chat.messages) {
      lines.push(m.role === 'user' ? '## You' : `## ${chatTitleModel(m)}`, '');
      lines.push(m.text || '_(no text)_', '');
    }
    download(`${chat.title.replace(/[^\w\- ]+/g, '').trim() || 'chat'}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
  }

  function chatTitleModel(m) { return m.model ? `Gemini (${m.model})` : 'Gemini'; }

  // ---------------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------------
  function wireComposer() {
    const input = $('composer-input');
    on(input, 'input', () => autoGrow(input));
    on(input, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    on(input, 'paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          e.preventDefault();
          addImageFile(item.getAsFile());
        }
      }
    });
    on($('send-btn'), 'click', () => sendMessage());
    on($('stop-btn'), 'click', stopStreaming);
    on($('attach-btn'), 'click', () => $('file-input').click());
    on($('file-input'), 'change', async (e) => {
      for (const file of Array.from(e.target.files || [])) await addImageFile(file);
      e.target.value = '';
    });

    const composer = $('composer');
    ['dragenter', 'dragover'].forEach((t) => on(composer, t, (e) => { e.preventDefault(); composer.classList.add('is-drop'); }));
    ['dragleave', 'drop'].forEach((t) => on(composer, t, (e) => { e.preventDefault(); composer.classList.remove('is-drop'); }));
    on(composer, 'drop', async (e) => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      for (const f of files) await addImageFile(f);
    });
  }

  function wireMessages() {
    on($('messages'), 'click', (e) => {
      const copyBtn = e.target.closest('.copy-code');
      if (copyBtn) {
        const pre = copyBtn.closest('.code-block').querySelector('pre');
        navigator.clipboard.writeText(pre.innerText)
          .then(() => { copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); })
          .catch(() => toast('Clipboard blocked by the browser', 'error'));
        return;
      }
      if (e.target.closest('.msg-body a')) return;
    });
  }

  function wireSettings() {
    on($('open-settings'), 'click', () => openSettings('connection'));
    on($('theme-toggle'), 'click', () => {
      state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      persistSettings();
    });
    document.querySelectorAll('.tab').forEach((t) => on(t, 'click', () => selectTab(t.dataset.tab)));

    const save = () => { readSettingsForm(); applySettings(); };
    const saveSoon = debounce(save, 350);
    document.querySelectorAll('#settings-modal input, #settings-modal select, #settings-modal textarea')
      .forEach((node) => {
        on(node, 'change', save);
        on(node, 'input', saveSoon);
      });

    on($('set-temperature'), 'input', () => { $('temperature-val').textContent = Number($('set-temperature').value).toFixed(2); });
    on($('set-topp'), 'input', () => { $('topp-val').textContent = Number($('set-topp').value).toFixed(2); });
    on($('set-font-scale'), 'input', () => { $('font-scale-val').textContent = $('set-font-scale').value + '%'; });

    on($('set-preset'), 'change', () => {
      const preset = CFG.SYSTEM_PRESETS.find((p) => p.id === $('set-preset').value);
      if (preset) { $('set-system').value = preset.text; save(); }
    });

    on($('test-key'), 'click', async () => {
      readSettingsForm();
      const key = state.settings.apiKey;
      if (!key) { toast('Enter a key first', 'error'); return; }
      const btn = $('test-key');
      btn.disabled = true; btn.textContent = 'Testing…';
      try {
        const models = await G.listModels(key, { base: baseForRequests() });
        state.liveModels = models;
        populateModelSelects();
        toast(`Key works — ${models.length} models available to this project`, 'ok', 5000);
      } catch (err) {
        const apiErr = err && err.apiError;
        toast(apiErr ? `${apiErr.title}: ${apiErr.hint}` : `Test failed: ${err.message}`, 'error', 8000);
      } finally {
        btn.disabled = false; btn.textContent = 'Test';
      }
    });

    on($('refresh-models'), 'click', async () => {
      if (!(await ensureUsableKey())) return;
      const btn = $('refresh-models');
      btn.disabled = true;
      try {
        const models = await G.listModels(usingProxy() ? 'proxy' : effectiveKey(), { base: baseForRequests() });
        state.liveModels = models;
        populateModelSelects();
        toast(`${models.length} models loaded from the API`, 'ok', 4000);
      } catch (err) {
        const apiErr = err && err.apiError;
        toast(apiErr ? apiErr.title : err.message, 'error', 6000);
      } finally { btn.disabled = false; }
    });

    on($('reset-quota'), 'click', () => { if (guard) guard.resetDay(); renderQuota(); toast('Daily counter reset', 'ok', 2000); });

    on($('export-chats'), 'click', () => download(`gemini-chats-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), settings: { ...state.settings, apiKey: '' }, chats: state.chats }, null, 2),
      'application/json'));
    on($('export-md'), 'click', exportMarkdown);
    on($('import-chats'), 'click', () => $('import-input').click());
    on($('import-input'), 'change', async (e) => {
      const file = (e.target.files || [])[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const incoming = Array.isArray(data) ? data : data.chats;
        if (!Array.isArray(incoming)) throw new Error('No "chats" array found');
        for (const c of incoming) {
          if (!c || !Array.isArray(c.messages)) continue;
          state.chats.push({ id: uid(), title: c.title || 'Imported chat', createdAt: c.createdAt || Date.now(), updatedAt: Date.now(), messages: c.messages });
        }
        persistChats();
        renderChatList();
        toast(`Imported ${incoming.length} chat(s)`, 'ok');
      } catch (err) {
        toast('Import failed: ' + err.message, 'error', 6000);
      } finally { e.target.value = ''; }
    });

    on($('wipe-storage'), 'click', () => {
      if (!confirm('Delete every saved chat and setting in this browser?')) return;
      Object.values(K).forEach((k) => localStorage.removeItem(k));
      localStorage.removeItem('geminiChat.daily.v1');
      location.reload();
    });

    document.querySelectorAll('#prompt-ideas .chip').forEach((chip) => {
      on(chip, 'click', () => {
        $('composer-input').value = chip.dataset.prompt;
        autoGrow($('composer-input'));
        $('composer-input').focus();
        $('settings-modal').close && $('settings-modal').close();
      });
    });
  }

  function wireChrome() {
    on($('new-chat'), 'click', () => newChat());
    on($('clear-chat'), 'click', () => {
      const chat = activeChat();
      if (!chat) return;
      if (chat.messages.length && !confirm('Clear all messages in this chat?')) return;
      chat.messages = [];
      chat.title = 'New chat';
      persistChats();
      renderActiveChat();
      renderChatList();
    });
    on($('chat-search'), 'input', renderChatList);
    on($('model-select'), 'change', (e) => {
      state.settings.model = e.target.value;
      syncSettingsForm();
      persistSettings();
      applySettings();
      toast(`Model: ${state.settings.model}`, 'ok', 2000);
    });
    on($('sidebar-toggle'), 'click', () => {
      $('sidebar').classList.toggle('is-open');
      $('scrim').hidden = !$('sidebar').classList.contains('is-open');
    });
    on($('scrim'), 'click', closeSidebar);

    const title = $('chat-title');
    on(title, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
    on(title, 'blur', () => {
      const chat = activeChat();
      if (!chat) return;
      const next = (title.textContent || '').trim().slice(0, 80) || 'New chat';
      if (next !== chat.title) { chat.title = next; persistChats(); renderChatList(); }
      title.textContent = chat.title;
    });

    on(document, 'keydown', (e) => {
      const modalOpen = $('settings-modal').open;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); }
      if (e.key === 'Escape' && state.stream && !modalOpen) { e.preventDefault(); stopStreaming(); }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); $('composer-input').focus(); }
    });

    on(window, 'offline', () => toast('You are offline — requests will fail until the connection returns', 'error', 6000));
    on(window, 'online', () => toast('Back online', 'ok', 2000));
  }

  function closeSidebar() {
    $('sidebar').classList.remove('is-open');
    $('scrim').hidden = true;
  }

  // ---------------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------------
  async function init() {
    const savedSettings = readStorage(K.settings, {});
    state.settings = Object.assign({}, CFG.DEFAULT_SETTINGS, savedSettings);

    const savedChats = readStorage(K.chats, []);
    state.chats = Array.isArray(savedChats) && savedChats.length ? savedChats : [];
    state.activeId = readStorage(K.activeChat, null);
    if (!state.chats.length) newChat(false);
    if (!state.chats.some((c) => c.id === state.activeId)) state.activeId = state.chats[0].id;

    // static selects
    const presetSelect = $('set-preset');
    for (const p of CFG.SYSTEM_PRESETS) presetSelect.appendChild(el('option', { value: p.id, text: p.label }));
    const safetySelect = $('set-safety');
    for (const t of CFG.SAFETY_THRESHOLDS) safetySelect.appendChild(el('option', { value: t.value, text: t.label }));

    applyTheme();
    document.documentElement.style.setProperty('--font-scale', (state.settings.fontScale / 100).toFixed(2));
    populateModelSelects();
    buildGuard();
    renderDataStats();

    wireScroll();
    wireComposer();
    wireMessages();
    wireSettings();
    wireChrome();

    renderChatList();
    renderActiveChat();
    syncSettingsForm();

    // keys + proxy, then refresh the badges
    const [env, proxy] = await Promise.all([loadEnvFile(), probeProxy()]);
    if (env) {
      state.envKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_KEY || '';
      if (env.GEMINI_MODEL && !savedSettings.model) state.settings.model = env.GEMINI_MODEL;
    }
    state.proxyAvailable = proxy;
    updateKeyBadge();
    populateModelSelects();
    renderActiveChat();

    if (state.keySource === 'none') {
      toast('Add your Gemini API key: edit .env (GEMINI_API_KEY=…) or Settings → Connection', 'info', 9000);
    } else if (state.keySource === 'env') {
      toast('API key loaded from .env', 'ok', 2200);
    }
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      toast('Served over plain HTTP from a non-local host: your key travels unencrypted. Use HTTPS.', 'error', 9000);
    }
    $('composer-input').focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // expose for debugging in the console
  window.GeminiChat = { state, sendMessage, regenerate, continueLast, stopStreaming, openSettings };
})();
