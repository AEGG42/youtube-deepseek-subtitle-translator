"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const inputPath = path.resolve(process.argv[2] || "");
const outputDirectory = path.resolve(process.argv[3] || "");
const ENTRY_LIMIT = 30_000;

if (!process.argv[2] || !process.argv[3]) {
  console.error(
    "Usage: node scripts/build-dictionary.js <ecdict.csv> <output-directory>"
  );
  process.exit(1);
}

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

function normalizeWord(value) {
  const word = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'");
  return /^[a-z]+(?:['-][a-z]+)*$/.test(word) && word.length <= 48
    ? word
    : "";
}

function cleanTranslation(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\[网络\]/.test(line))
    .slice(0, 4)
    .join("\n")
    .slice(0, 280);
}

function numericRank(value) {
  const rank = Number(value);
  return Number.isInteger(rank) && rank > 0 ? rank : Number.POSITIVE_INFINITY;
}

function scoreEntry(fields) {
  const collins = Number(fields[5]) || 0;
  const oxford = String(fields[6] || "").trim() === "1";
  const tags = String(fields[7] || "").toLowerCase();
  const bnc = numericRank(fields[8]);
  const contemporary = numericRank(fields[9]);
  let score = Math.min(bnc, contemporary);

  if (oxford) {
    score = Math.min(score, 12_000);
  }
  if (collins > 0) {
    score = Math.min(score, 30_000 - collins * 4_000);
  }
  if (/\b(?:zk|gk|cet4)\b/.test(tags)) {
    score = Math.min(score, 14_000);
  } else if (/\b(?:cet6|ky|toefl|ielts)\b/.test(tags)) {
    score = Math.min(score, 24_000);
  } else if (/\bgre\b/.test(tags)) {
    score = Math.min(score, 38_000);
  }

  return score;
}

function exchangeAliases(value) {
  return String(value || "")
    .split("/")
    .map((item) => item.slice(item.indexOf(":") + 1))
    .map(normalizeWord)
    .filter(Boolean);
}

async function main() {
  const candidates = new Map();
  const input = fs.createReadStream(inputPath, { encoding: "utf8" });
  const lines = readline.createInterface({
    input,
    crlfDelay: Infinity
  });
  let isHeader = true;

  for await (const line of lines) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    const fields = parseCsvLine(line);
    const word = normalizeWord(fields[0]);
    const translation = cleanTranslation(fields[3]);
    const score = scoreEntry(fields);
    if (!word || !translation || !Number.isFinite(score) || score > 45_000) {
      continue;
    }

    const current = candidates.get(word);
    if (!current || score < current.score) {
      candidates.set(word, {
        word,
        phonetic: String(fields[1] || "").trim().slice(0, 80),
        translation,
        exchange: exchangeAliases(fields[10]),
        score
      });
    }
  }

  const selected = [...candidates.values()]
    .sort((left, right) => left.score - right.score || left.word.localeCompare(right.word))
    .slice(0, ENTRY_LIMIT);
  const entries = new Map(
    selected.map((entry) => [
      entry.word,
      [entry.phonetic, entry.translation]
    ])
  );

  for (const entry of selected) {
    for (const alias of entry.exchange) {
      if (!entries.has(alias)) {
        entries.set(alias, [
          entry.phonetic,
          entry.translation,
          entry.word
        ]);
      }
    }
  }

  const shards = new Map();
  for (const [word, value] of entries) {
    const shardName = /^[a-z]/.test(word) ? word[0] : "_";
    if (!shards.has(shardName)) {
      shards.set(shardName, {});
    }
    shards.get(shardName)[word] = value;
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  let totalBytes = 0;
  for (const [shardName, shard] of [...shards].sort()) {
    const ordered = Object.fromEntries(
      Object.entries(shard).sort(([left], [right]) => left.localeCompare(right))
    );
    const output = JSON.stringify(ordered);
    fs.writeFileSync(
      path.join(outputDirectory, `${shardName}.json`),
      output
    );
    totalBytes += Buffer.byteLength(output);
  }

  console.log(
    `Built ${entries.size} dictionary keys in ${shards.size} shards (${Math.round(totalBytes / 1024)} KiB).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
