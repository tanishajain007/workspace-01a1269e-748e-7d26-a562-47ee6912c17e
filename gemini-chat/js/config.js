/**
 * config.js — model catalogue + default settings for the Gemini chat client.
 *
 * Model facts below were read from https://ai.google.dev/gemini-api/docs/models
 * and /docs/pricing on 2026-10-10. Token limits and "free tier" flags change
 * over time, so the app can also pull the live list from GET /v1beta/models.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppConfig = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const API_VERSION = 'v1beta';

  /**
   * Free-tier capable models.
   *  inputLimit / outputLimit = null when not verified for that model.
   *  thinking = supported thinking levels (null = do not expose the control).
   */
  const MODELS = [
    {
      id: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash',
      tier: 'Free',
      stable: true,
      inputLimit: 1048576,
      outputLimit: 65536,
      thinking: null,
      note: 'Stable, previous-generation Flash. Balanced speed + multimodal.',
    },
    {
      id: 'gemini-3.7-flash',
      label: 'Gemini 3.7 Flash (deprecated alias)',
      tier: 'Free',
      stable: false,
      inputLimit: 1048576,
      outputLimit: 65536,
      thinking: ['low', 'medium', 'high'],
      note: 'Deprecated: Google routes this model code to gemini-3.8-flash automatically.',
    },
    {
      id: 'gemini-3.8-flash',
      label: 'Gemini 3.8 Flash',
      tier: 'Free',
      stable: true,
      inputLimit: 1048576,
      outputLimit: 65536,
      thinking: ['low', 'medium', 'high'],
      note: 'Newest stable Flash. Best free-tier choice for coding + agents.',
    },
    {
      id: 'gemini-3.5-flash-lite',
      label: 'Gemini 3.5 Flash-Lite',
      tier: 'Free',
      stable: true,
      inputLimit: null,
      outputLimit: null,
      thinking: null,
      note: 'Cheapest/fastest. Good for high-volume, simple prompts.',
    },
    {
      id: 'gemini-3.1-flash-lite',
      label: 'Gemini 3.1 Flash-Lite',
      tier: 'Free',
      stable: true,
      inputLimit: null,
      outputLimit: null,
      thinking: null,
      note: 'Older Flash-Lite, still on the free tier.',
    },
    {
      id: 'gemini-3-flash-preview',
      label: 'Gemini 3 Flash (preview)',
      tier: 'Free',
      stable: false,
      inputLimit: null,
      outputLimit: null,
      thinking: null,
      note: 'Preview model — behaviour can change without notice.',
    },
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      tier: 'Free*',
      stable: true,
      inputLimit: null,
      outputLimit: null,
      thinking: null,
      note: '*Free but access is limited to projects that already used 2.5 models.',
    },
    {
      id: 'gemini-2.5-flash-lite',
      label: 'Gemini 2.5 Flash-Lite',
      tier: 'Free*',
      stable: true,
      inputLimit: null,
      outputLimit: null,
      thinking: null,
      note: '*Free but access is limited to projects that already used 2.5 models.',
    },
    {
      id: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      tier: 'Free*',
      stable: true,
      inputLimit: null,
      outputLimit: null,
      thinking: null,
      note: 'Only Pro-class model on the free tier; very low daily quota.',
    },
  ];

  /** Gemini safety categories accepted by generateContent. */
  const SAFETY_CATEGORIES = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
  ];

  const SAFETY_THRESHOLDS = [
    { value: 'BLOCK_NONE', label: 'Block none (least filtering)' },
    { value: 'BLOCK_ONLY_HIGH', label: 'Block only high probability' },
    { value: 'BLOCK_MEDIUM_AND_ABOVE', label: 'Block medium and above' },
    { value: 'BLOCK_LOW_AND_ABOVE', label: 'Block low and above (strictest)' },
    { value: 'OFF', label: 'OFF (model decides — 3.x models)' },
  ];

  const SYSTEM_PRESETS = [
    {
      id: 'general',
      label: 'General assistant',
      text:
        'You are a helpful, precise assistant. Answer directly, use Markdown for structure, ' +
        'and keep answers as short as the question allows. If you are unsure, say so instead of guessing.',
    },
    {
      id: 'coder',
      label: 'Senior software engineer',
      text:
        'You are a senior software engineer. Reply with working, runnable code in fenced code blocks ' +
        'with the language tagged. Explain trade-offs in 1-3 short bullet points after the code. ' +
        'Never invent APIs; if something is version-dependent, say which version you targeted.',
    },
    {
      id: 'tutor',
      label: 'Patient tutor',
      text:
        'You are a patient tutor. Teach step by step, define jargon on first use, give one small ' +
        'example per idea, and finish with one check-question to confirm understanding.',
    },
    {
      id: 'editor',
      label: 'Brutal editor',
      text:
        'You are a blunt editor. Point out the single biggest weakness first, then give a concrete ' +
        'rewrite. No compliments, no filler.',
    },
    {
      id: 'none',
      label: 'No system instruction',
      text: '',
    },
  ];

  const DEFAULT_SETTINGS = {
    // --- connection -------------------------------------------------------
    apiKey: '',              // filled from .env, localStorage, or the settings panel
    requestMode: 'auto',     // 'auto' | 'browser' | 'proxy'
    model: 'gemini-3.6-flash',
    streaming: true,
    timeoutMs: 120000,
    maxRetries: 2,           // retries AFTER the first attempt, for 429/5xx only

    // --- generation -------------------------------------------------------
    temperature: 0.7,
    topP: 0.95,
    topK: '',                // '' = omit (2.5 Pro rejects topK)
    maxOutputTokens: 4096,
    stopSequences: '',       // comma separated
    thinkingLevel: 'off',    // 'off' | 'low' | 'medium' | 'high'

    // --- conversation -----------------------------------------------------
    systemPreset: 'general',
    systemInstruction: SYSTEM_PRESETS[0].text,
    contextTokenBudget: 32000,  // keep the last ~N tokens of history per request
    rememberAcrossReloads: true,

    // --- safety -----------------------------------------------------------
    safetyThreshold: 'BLOCK_MEDIUM_AND_ABOVE',

    // --- free-tier quota guard (see aistudio.google.com/rate-limit) -------
    guardEnabled: true,
    guardRpm: 8,             // your project's RPM minus a safety margin
    guardRpd: 200,           // your project's RPD minus a safety margin
    minIntervalMs: 1500,     // client-side spacing between requests

    // --- ui ---------------------------------------------------------------
    theme: 'dark',
    fontScale: 100,
    showThinking: true,
    showTokenStats: true,
  };

  const STORAGE_KEYS = {
    settings: 'geminiChat.settings.v1',
    chats: 'geminiChat.chats.v1',
    activeChat: 'geminiChat.active.v1',
    usage: 'geminiChat.usage.v1',
  };

  return {
    API_BASE,
    API_VERSION,
    MODELS,
    SAFETY_CATEGORIES,
    SAFETY_THRESHOLDS,
    SYSTEM_PRESETS,
    DEFAULT_SETTINGS,
    STORAGE_KEYS,
  };
});
