#!/usr/bin/env node
'use strict';

// Copies a verified dist/ build into the canonical published files
// (index.html, og-image.png). report.json stays the single source of truth;
// canonical index.html and og-image.png are generated artifacts that should
// never be hand edited. This script is the only intended way to refresh them
// from a local dist/ build.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CANONICAL = [
  { name: 'index.html', from: path.join(DIST, 'index.html') },
  { name: 'og-image.png', from: path.join(DIST, 'og-image.png') },
];

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

for (const file of CANONICAL) {
  if (!fs.existsSync(file.from)) {
    fail(`dist/${file.name} がありません。先に npm run build を実行してください。`);
  }
}

for (const file of CANONICAL) {
  const target = path.join(ROOT, file.name);
  fs.copyFileSync(file.from, target);
  console.log(`✅ ${file.name} を公開位置へコピーしました (${fs.statSync(target).size} bytes)`);
}

console.log('✅ 公開生成物を更新しました。差分を確認して commit してください。');
