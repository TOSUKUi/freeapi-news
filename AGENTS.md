# AGENTS.md

無料 LLM API 速報。毎日更新される無料・割引 LLM API のランキングを、単一の静的 HTML ページとして GitHub Pages に公開する。

## Stack

- Node.js 20 以上。ランタイム依存なし (devDependencies は検証用の ajv のみ)。
- 静的ビルド。`build/build-html.js` が `report.json` を読んで `index.html` を生成する。フレームワークなし、React なし、サーバーなし。
- スタイルは Tailwind CSS (CDN を 3.4.1 に固定、浮動版を使わない) と shadcn/ui のデザイントークン (CSS 変数 `:root` と `.dark`)。Tailwind の色はトークン変数に対応付け、色はトークンを唯一の真実源にする。
- フォントは Space Grotesk (見出し)、Noto Sans JP (本文)、JetBrains Mono (コード)。
- 配布は GitHub Pages。`index.html` と `report.json` は生成物だが配布に必須のため git で追跡する。

## Build and run

- `npm run validate` … report.json をスキーマで検証。
- `npm run build` … index.html を生成。
- `npm run collect` … `.devops/batch/run-skill.sh` で収集スキルを実行。
- `npm run deploy` … `.devops/deploy/git-push.sh` で配布。
- `npm run full` … collect → validate → build → deploy。

## Data flow

`report.json` (入力) → `build/build-html.js` → `index.html` (出力)。接続手順のテキストは report.json に持たず、ビルドが `build-html.js` 内の版付きテンプレート (`AGENT_TEMPLATE_VERSION`) から生成する。

## Conventions

- 単一 HTML ファイル。メニューやタブは置かない。
- ダークモードは `localStorage["theme"]` に保存し、描画前のインラインスクリプトが `prefers-color-scheme` をフォールバックに dark クラスを付与する (ちらつき防止)。
- ランキングは `ranked_offers` の `ranking_eligible === true` かつベンチマークのティアが S/A/B のものだけ入門させる。並びは `last_verified` 降順 (鮮度) → ティア → 名前。生のベンチマークスコアを異なるベンチマーク間で比較しない。
- report.json のスキーマは `.agents/skills/llm-deals-intelligence-skill/schemas/daily_report.schema.json`。`last_verified` は ranking eligible で必須、`free_model_names` は router で必須かつ非空。
- 収集スキルは `.agents/skills/llm-deals-intelligence-skill/`。UI 参照スキルは `.agents/skills/shadcn/` (skills-lock.json で固定)。

## Notes for agents

- このファイルは最小の bootstrap。詳細な規約やエリアごとの規約は /audit または /sync で補完する。
- 設計の審議履歴とスコープ管理と検証チェックリストは `docs/` に置き、git では追跡しない。
