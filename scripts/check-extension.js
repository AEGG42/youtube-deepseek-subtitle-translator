"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);
const errors = [];

if (manifest.manifest_version !== 3) {
  errors.push("manifest_version must be 3");
}
if (manifest.version !== packageJson.version) {
  errors.push(
    `Version mismatch: manifest ${manifest.version}, package ${packageJson.version}`
  );
}

const referencedFiles = new Set([
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page
]);

function addManifestAssets(value) {
  if (typeof value === "string") {
    referencedFiles.add(value);
    return;
  }
  for (const asset of Object.values(value || {})) {
    if (typeof asset === "string") {
      referencedFiles.add(asset);
    }
  }
}

addManifestAssets(manifest.icons);
addManifestAssets(manifest.action?.default_icon);

for (const contentScript of manifest.content_scripts || []) {
  for (const file of [...(contentScript.js || []), ...(contentScript.css || [])]) {
    referencedFiles.add(file);
  }
}

for (const relativeFile of referencedFiles) {
  if (!relativeFile) {
    continue;
  }
  if (!fs.existsSync(path.join(root, relativeFile))) {
    errors.push(`Manifest references missing file: ${relativeFile}`);
  }
}

const sourceFiles = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => entry.name);

for (const relativeFile of sourceFiles) {
  const source = fs.readFileSync(path.join(root, relativeFile), "utf8");
  try {
    new vm.Script(source, { filename: relativeFile });
  } catch (error) {
    errors.push(`JavaScript syntax error in ${relativeFile}: ${error.message}`);
  }

  if (/Bearer\s+sk-[A-Za-z0-9_-]{8,}/.test(source)) {
    errors.push(`Possible hard-coded API key in ${relativeFile}`);
  }
}

const contentScriptFiles = new Set(
  (manifest.content_scripts || []).flatMap((contentScript) => contentScript.js || [])
);
for (const relativeFile of contentScriptFiles) {
  const source = fs.readFileSync(path.join(root, relativeFile), "utf8");
  if (/chrome\.storage\b/.test(source)) {
    errors.push(
      `Content script accesses extension storage and could expose secrets: ${relativeFile}`
    );
  }
  if (/GET_EXTENSION_SETTINGS/.test(source)) {
    errors.push(
      `Content script requests privileged settings instead of public settings: ${relativeFile}`
    );
  }
}

for (const htmlFile of ["popup.html", "options.html"]) {
  const html = fs.readFileSync(path.join(root, htmlFile), "utf8");
  const assetPattern = /<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/g;
  let match;
  while ((match = assetPattern.exec(html))) {
    const asset = match[1];
    if (!asset.startsWith("http") && !fs.existsSync(path.join(root, asset))) {
      errors.push(`${htmlFile} references missing asset: ${asset}`);
    }
  }
}

const dictionaryDirectory = path.join(root, "assets", "dictionary");
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  const dictionaryPath = path.join(dictionaryDirectory, `${letter}.json`);
  if (!fs.existsSync(dictionaryPath)) {
    errors.push(`Dictionary shard is missing: assets/dictionary/${letter}.json`);
    continue;
  }
  try {
    const shard = JSON.parse(fs.readFileSync(dictionaryPath, "utf8"));
    if (!shard || typeof shard !== "object" || Array.isArray(shard)) {
      errors.push(`Dictionary shard is invalid: assets/dictionary/${letter}.json`);
    }
  } catch (error) {
    errors.push(
      `Dictionary shard is invalid JSON: assets/dictionary/${letter}.json (${error.message})`
    );
  }
}
if (!fs.existsSync(path.join(dictionaryDirectory, "NOTICE.txt"))) {
  errors.push("Dictionary attribution is missing: assets/dictionary/NOTICE.txt");
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Extension check passed: ${referencedFiles.size} manifest assets, ${sourceFiles.length} JavaScript files.`
  );
}
