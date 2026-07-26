"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../shared.js");

test("sanitizeSettings returns safe defaults for invalid values", () => {
  const settings = Shared.sanitizeSettings({
    enabled: "yes",
    apiKey: "  secret-value  ",
    targetLanguage: "unknown",
    model: "made-up-model",
    displayMode: "sideways",
    fontSize: 900,
    backgroundOpacity: -2,
    subtitleBottom: "not-a-number",
    translationDelay: 10
  });

  assert.equal(settings.enabled, true);
  assert.equal(settings.prefetchEnabled, true);
  assert.equal(settings.wordLookupEnabled, true);
  assert.equal(settings.wordLookupAiFallback, true);
  assert.equal(settings.apiKey, "secret-value");
  assert.equal(settings.targetLanguage, "zh-CN");
  assert.equal(settings.model, "deepseek-v4-flash");
  assert.equal(settings.displayMode, "bilingual");
  assert.equal(settings.fontSize, 48);
  assert.equal(settings.backgroundOpacity, 0.2);
  assert.equal(settings.subtitleBottom, 12);
  assert.equal(settings.translationDelay, 420);
});

test("toPublicSettings never includes the API key", () => {
  const publicSettings = Shared.toPublicSettings({
    ...Shared.DEFAULT_SETTINGS,
    apiKey: "a-private-key"
  });

  assert.equal(Object.hasOwn(publicSettings, "apiKey"), false);
  assert.equal(publicSettings.prefetchEnabled, true);
  assert.equal(publicSettings.wordLookupEnabled, true);
  assert.equal(publicSettings.wordLookupAiFallback, true);
  assert.equal(publicSettings.model, "deepseek-v4-flash");
});

test("maskApiKey reveals only a small prefix and suffix", () => {
  assert.equal(Shared.maskApiKey(""), "");
  assert.equal(Shared.maskApiKey("short"), "••••••••");
  assert.equal(
    Shared.maskApiKey("abcdefghijklmnop"),
    "abcd••••••mnop"
  );
});

test("normalizeWhitespace removes zero-width and repeated whitespace", () => {
  assert.equal(
    Shared.normalizeWhitespace("  Hello\u200B \n  world  "),
    "Hello world"
  );
});
