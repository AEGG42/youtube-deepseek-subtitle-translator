(function initializeShared(globalScope) {
  "use strict";

  const TARGET_LANGUAGES = Object.freeze({
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    en: "English",
    ja: "日本語",
    ko: "한국어",
    es: "Español",
    fr: "Français",
    de: "Deutsch",
    pt: "Português",
    ru: "Русский",
    ar: "العربية"
  });

  const MODELS = Object.freeze({
    "deepseek-v4-flash": "DeepSeek V4 Flash（推荐）",
    "deepseek-v4-pro": "DeepSeek V4 Pro"
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    apiKey: "",
    prefetchEnabled: true,
    wordLookupEnabled: true,
    wordLookupAiFallback: true,
    targetLanguage: "zh-CN",
    model: "deepseek-v4-flash",
    displayMode: "bilingual",
    fontSize: 30,
    backgroundOpacity: 0.62,
    subtitleBottom: 12,
    translationDelay: 420
  });

  const PUBLIC_SETTING_KEYS = Object.freeze([
    "enabled",
    "prefetchEnabled",
    "wordLookupEnabled",
    "wordLookupAiFallback",
    "targetLanguage",
    "model",
    "displayMode",
    "fontSize",
    "backgroundOpacity",
    "subtitleBottom",
    "translationDelay"
  ]);

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  function normalizeWhitespace(value) {
    return String(value ?? "")
      .replace(/\u200B/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sanitizeSettings(rawSettings = {}) {
    const raw = rawSettings && typeof rawSettings === "object" ? rawSettings : {};

    return {
      enabled:
        typeof raw.enabled === "boolean"
          ? raw.enabled
          : DEFAULT_SETTINGS.enabled,
      apiKey:
        typeof raw.apiKey === "string"
          ? raw.apiKey.trim()
          : DEFAULT_SETTINGS.apiKey,
      prefetchEnabled:
        typeof raw.prefetchEnabled === "boolean"
          ? raw.prefetchEnabled
          : DEFAULT_SETTINGS.prefetchEnabled,
      wordLookupEnabled:
        typeof raw.wordLookupEnabled === "boolean"
          ? raw.wordLookupEnabled
          : DEFAULT_SETTINGS.wordLookupEnabled,
      wordLookupAiFallback:
        typeof raw.wordLookupAiFallback === "boolean"
          ? raw.wordLookupAiFallback
          : DEFAULT_SETTINGS.wordLookupAiFallback,
      targetLanguage: Object.hasOwn(TARGET_LANGUAGES, raw.targetLanguage)
        ? raw.targetLanguage
        : DEFAULT_SETTINGS.targetLanguage,
      model: Object.hasOwn(MODELS, raw.model)
        ? raw.model
        : DEFAULT_SETTINGS.model,
      displayMode: ["bilingual", "translationOnly"].includes(raw.displayMode)
        ? raw.displayMode
        : DEFAULT_SETTINGS.displayMode,
      fontSize: Math.round(
        clampNumber(raw.fontSize, 18, 48, DEFAULT_SETTINGS.fontSize)
      ),
      backgroundOpacity:
        Math.round(
          clampNumber(
            raw.backgroundOpacity,
            0.2,
            0.9,
            DEFAULT_SETTINGS.backgroundOpacity
          ) * 100
        ) / 100,
      subtitleBottom: Math.round(
        clampNumber(
          raw.subtitleBottom,
          6,
          35,
          DEFAULT_SETTINGS.subtitleBottom
        )
      ),
      translationDelay: Math.round(
        clampNumber(
          raw.translationDelay,
          420,
          900,
          DEFAULT_SETTINGS.translationDelay
        )
      )
    };
  }

  function toPublicSettings(settings) {
    const sanitized = sanitizeSettings(settings);
    return PUBLIC_SETTING_KEYS.reduce((result, key) => {
      result[key] = sanitized[key];
      return result;
    }, {});
  }

  function hasApiKey(settings) {
    return sanitizeSettings(settings).apiKey.length > 0;
  }

  function maskApiKey(apiKey) {
    const normalized = String(apiKey ?? "").trim();
    if (!normalized) {
      return "";
    }
    if (normalized.length <= 10) {
      return "••••••••";
    }
    return `${normalized.slice(0, 4)}••••••${normalized.slice(-4)}`;
  }

  const api = Object.freeze({
    DEFAULT_SETTINGS,
    MODELS,
    PUBLIC_SETTING_KEYS,
    TARGET_LANGUAGES,
    clampNumber,
    hasApiKey,
    maskApiKey,
    normalizeWhitespace,
    sanitizeSettings,
    toPublicSettings
  });

  globalScope.DeepSeekTranslatorShared = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
