# AGENTS.md

## Purpose

無料・割引 LLM API の日次速報サイト。無料で使える高性能・フロンティア級 LLM API のランキングを、単一の静的 HTML ページとして GitHub Pages に毎日公開する。

- **誰のために**: 開発者が「今、無料で使える高性能 LLM API は何か」を一目で把握できるようにする。
- **最重要原則**: 捏造・誤データを絶対に公開しない。エンドポイント・ベンチマーク・無料枠は毎回公式ドキュメントまたは公式 API から調査し、バリデータが機械的に再検証する。更新はカジュアルに、データの正確さは妥協しない。
- **失敗時の振る舞い**: 収集や検証に失敗したら、無理に出さず前回のレポートを生存させる (fail-safe)。壊れたデータで上書きしない。

## Stack

- Node.js 20 以上。ランタイム依存なし (devDependencies は検証用の ajv のみ)。
- 静的ビルド。`build/build-html.js` が `report.json` を読んで `index.html` を生成。フレームワークなし、React なし、サーバーなし。
- スタイルは Tailwind CSS (CDN を 3.4.1 に固定、浮動版を使わない) と shadcn/ui のデザイントークン (CSS 変数 `:root` と `.dark`)。色はトークンを唯一の真実源にする。
- フォントは Space Grotesk (見出し)、Noto Sans JP (本文)、JetBrains Mono (コード)。
- 配布は GitHub Pages。
- 収集は pi (LLM エージェント) と `@nqbao/pi-json-schema` extension (構造化出力の強制)。ローカルモデル (`PI_MODEL=litellm/local`) での実行を前提にする。

## Build and run

- `npm run validate` … report.json をスキーマで検証 (auto-fix + 問題オファーの除外)。
- `npm run build` … index.html を生成。
- `npm run collect` … `.devops/batch/run-skill.sh` で並列収集バッチを実行。
- `npm run deploy` … `.devops/deploy/git-push.sh` で配布。
- `npm run full` … collect → validate → build → deploy。

## Architecture — collection pipeline

`.devops/batch/run-skill.sh` が並列・fail-safe の収集バッチを回す。役割を細かく分け、各 LLM 呼び出しを軽く保つ (ローカルモデル前提)。

1. **Discovery / Refresh / Crawl ワーカー** (LLM, 並列, `GLOBAL_CONCURRENCY` でスロットル)
   - 公式ドキュメント/公式 API から**生の事実 (facts) のみ**を抽出する。`schemas/crawl-facts.schema.json` (enum 一切なし) に従い `json_output` で出力。
   - 判断しない、enum を書かない。`classification` / `delivery_type` / `free_allowance_rank` / `tier` はワーカーの管轄外。
2. **Merger** (決定的, LLM/ネットワーク不要, `.devops/batch/reduce-crawl.js`)
   - facts から enum を**決定的に導出**: `delivery_type` は `provider-registry.json` から、`free_allowance_rank` / `total_parameters_b` / `tier` は引用テキストとベンチマークから。代表スコアは tier 判定と同じ Terminal-Bench 2.1 を優先 (異なるベンチマーク間の比較を避ける)。
   - 品質ゲート (paid-API / app-only / 30B 未満 / tier) を適用し、ベンチマーク state をマージし、`page_cache.json` を更新する。
3. **Classifier** (LLM, `schemas/classifications.schema.json` で enum 強制)
   - 正規化済み candidate の `classification` と confidence を最終判定する。
4. **Editor** (LLM, `daily_report.schema.json` で強制)
   - candidate と classifier の結果から日本語レポートを組み、`json_output` で `report.json` を出す。fetch/検索はしない。

**核心原則**: enum は LLM に書かせない。機械的に導出できるものは merger が決定的に出し、LLM は事実抽出と判断 (classification) だけ担う。全 LLM 呼び出しは `--json-schema` / `--json-output` で縛り、スキーマ違反の実行は失敗させて前回レポートを生存させる。

**page cache + API 優先**: `state/page_cache.json` が fetch 成功 URL を実行をまたいで蓄積し、manifest が新鮮な URL を `cached_urls` としてワーカーに渡す (継続してあれば再利用、dead/stale なら web_search/browser で代替)。API カタログで取得できるプロバイダー (registry の `api_catalog_url`、例: OpenRouter `GET /api/v1/models`) はスクレイピングより API を優先する。

## Data flow

`report.json` (入力) → `build/build-html.js` → `index.html` (出力)。接続手順のテキストは report.json に持たず、ビルドが `build-html.js` 内の版付きテンプレート (`AGENT_TEMPLATE_VERSION`) から生成する。エンドポイントは `build/provider-registry.json` が唯一の真実源 (公式ドキュメント由来、`delivery_type` / `api_catalog_url` を含む)。バリデータとビルドと収集スキルが共有し、収集スキルは未登録プロバイダーを公式ドキュメントから調査して `added_from` 証跡付きで登録に追加する。

## Conventions

- 単一 HTML ファイル。メニューやタブは置かない。
- ダークモードは `localStorage["theme"]` に保存し、描画前のインラインスクリプトが `prefers-color-scheme` をフォールバックに dark クラスを付与 (ちらつき防止)。
- ランキングは `ranked_offers` の `ranking_eligible === true` かつティア S/A/B のみ入門。並びは ティア (S>A>B) → 無料枠の余裕度 (`free_allowance_rank`: AMPLE>NORMAL>TIGHT>TINY) → ベンチマークスコア降順 → `last_verified` 降順 → 名前。生のベンチマークスコアを異なるベンチマーク間で比較しない。
- `ranked_offers` に入れるオファーは必ず `ranking_eligible: true`。対象外は `excluded_offers` へ (ranked に `ranking_eligible: false` で置く矛盾は禁止。ビルドがフィルタして消える)。
- ベンチマークスコアは `state/benchmarks.json` に永続化し、再生成で失わない。バリデータが退行と未永続化をハードフェイルで防ぐ。
- 総パラメータ 30B 未満はローカル実行領域なのでランキングしない (MoE は active ではなく総数で判定。例外: ティア S/A の競争力を持つ小型モデル)。
- ティア S/A は Terminal-Bench 2.1 の 50% 以上が必須。未公表・未満はティア B まで。バリデータが強制する。
- report.json のスキーマは `.agents/skills/llm-deals-intelligence-skill/schemas/daily_report.schema.json` (draft-07)。`last_verified` は ranking eligible で必須、`free_model_names` は router で必須かつ非空。
- `base_url` と `model_id` は毎回公式ドキュメントを取得して書く (記憶からの記入は禁止)。ランキング対象オファーは `endpoint_source` が必須。`npm run validate` はレジストリ整合性を検査し、引用先ページをバリデータ自身が再取得して base_url を明記していなければハードフェイルする。
- 無料アプリ/チャットアクセスは無料 API ではない (API が有料ならランキング対象外)。データ共有 opt-in の無料枠は `conditional_credits` (`F_CONDITIONAL`)。
- 収集スキルは `.agents/skills/llm-deals-intelligence-skill/`。UI 参照スキルは `.agents/skills/shadcn/` (skills-lock.json で固定)。

## State and git tracking

- **永続状態 (git で追跡)**: `report.json`, `index.html`, `og-image.png`, `build/provider-registry.json`, `state/benchmarks.json`, `state/known_offers.json`, `state/page_cache.json`。配布に必須、または実行をまたぐ収集の知識。
- **中間成果物 (git で追跡しない、.gitignore)**: `state/crawl/` (1 実行の一時データ — manifest / artifacts / snapshots / reduced / logs)、`.devops/batch/.crawl.lock`。再生成で失ってよい。

## Notes for agents

- このファイルは最小の bootstrap。詳細な規約やエリアごとの規約は /audit または /sync で補完する。
- 設計の審議履歴とスコープ管理と検証チェックリストは `docs/` に置き、git では追跡しない。
