# AGENTS.md

## Purpose

無料・割引 LLM API の日次速報サイト。無料で使える高性能・フロンティア級 LLM API のランキングを、単一の静的 HTML ページとして GitHub Pages に毎日公開する。

- **誰のために**: 開発者が「今、無料で使える高性能 LLM API は何か」を一目で把握できるようにする。
- **最重要原則**: 捏造・誤データを絶対に公開しない。エンドポイント・ベンチマーク・無料枠は毎回公式ドキュメントまたは公式 API から調査し、バリデータが機械的に再検証する。更新はカジュアルに、データの正確さは妥協しない。
- **失敗時の振る舞い**: 収集や検証に失敗したら、無理に出さず前回のレポートを生存させる (fail-safe)。壊れたデータで上書きしない。

## Stack

- Node.js 24 必須 (`>=24.0.0 <25`)。運用状態は Node 24 組み込み `node:sqlite` で扱う。ランタイム依存なし (devDependencies は検証用の ajv のみ)。SQLite Agent Skill も MCP サーバーも追加しない (ビルトインランタイムで十分と判断)。
- 静的ビルド。`build/build-html.js` が `report.json` を読んで `index.html` を生成。フレームワークなし、React なし、サーバーなし。
- スタイルは Tailwind CSS (CDN を 3.4.1 に固定、浮動版を使わない) と shadcn/ui のデザイントークン (CSS 変数 `:root` と `.dark`)。色はトークンを唯一の真実源にする。
- フォントは Space Grotesk (見出し)、Noto Sans JP (本文)、JetBrains Mono (コード)。
- 配布は GitHub Pages。
- 収集は pi (LLM エージェント) と `@nqbao/pi-json-schema` extension (構造化出力の強制)。ローカルモデル (`PI_MODEL=litellm/free`) での実行を前提にする。

## Build and run

- `npm run collect` … フェイルセーフ収集。候補の検証まで通し、ローカルで昇格 (プッシュしない)。`.devops/db/cli.js collect`。
- `npm run collect:dry-run` … 収集 → 候補検証。昇格・デプロイしない (経路の確認用)。
- `npm run deploy` … 最後に昇格した世代をコミット & プッシュ。プッシュ失敗は `validated_not_deployed` として再デプロイ用に保持。
- `npm run full` … collect → 昇格 → deploy を一括。
- `npm run validate` … 現行の公開スナップショットを検証 (auto-fix + 問題オファーの除外)。
- `npm run build` … 現行の公開スナップショットから `dist/index.html` / `dist/og-image.png` を生成 (canonical は直接触らない)。`npm run promote:dist` で公開位置へ反映。
- `npm run db:status` … SQLite スキーマ・実行状態を表示。`db:migrate` / `db:bootstrap` / `db:import-legacy` / `db:restore` 等の副コマンドあり。
- `npm run set-hidden -- <provider_key> <exact_model_id> <true|false>` … 運用者が特定 offer の公開・非表示を切り替える。カタログ更新では解除されない。
- `npm run validate-candidate` … 候補ディレクトリの report / HTML / OGP を検証。
- `npm run promote` … 検証済み候補を昇格 (公開物を一括置換)。
- `npm run recover` … 中断された昇格・展開状態を復旧。
- `npm run cleanup` … 7 日より古い実行ディレクトリを削除。
- `npm test` … コレクタのフィクスチャテスト (`node --test .devops/db/*.test.js`)。

## Architecture — collection pipeline

`.devops/db/collect.js` がフェイルセーフのパイプラインを回す。SQLite (`.agents/skills/llm-deals-intelligence-skill/state/collector.sqlite`) が唯一の運用状態。既知オファーの確認 (known lane) と新規探索 (discovery lane) を分け、失敗した収集が前回の公開を壊さない。機械的な作業はコード、LLM は事実抽出と分類・執筆だけ (ローカルモデル前提、各呼び出しは軽い)。

1. **catalog** (決定的, `.devops/db/catalog.js`) … `api_catalog_url` を持つプロバイダー (例: OpenRouter `GET /api/v1/models`) を公式 API から直接列挙。LLM フォールバックなし。失敗時は前回オファーを保持。
2. **known_refresh / discovery ワーカー** (LLM, 並列, `GLOBAL_CONCURRENCY` でスロットル) … 公式ドキュメントから**生の事実のみ**を抽出し `schemas/crawl-facts.schema.json` で `json_output`。enum は書かない。discovery の失敗は既知オファーに影響しない。discovery レーンは1巨大タスクではなく小さなチャンクタスク (`discovery:sources:N` / `discovery:terms:N`) に分割される (spec 0005)。日次予算とチャンクサイズは `DISCOVERY_SOURCE_BUDGET` (既定20) / `DISCOVERY_TERM_BUDGET` (既定12) / `DISCOVERY_SOURCE_CHUNK` (既定5) / `DISCOVERY_TERM_CHUNK` (既定4)。priority/最終試行順の先頭から切るため、ヘルスカウンタと合わせてプールを日次ローテーションする。1チャンクのタイムアウトは自分だけしか失わない。
3. **lane reduce** (決定的, `.devops/db/lanes.js`) … facts からライブネス (`verified` / `stale` / `confirmed_removed`) と enum を導出。検証失敗は前回事実を `stale` として持ち越し、4 連続失敗で caution。既知 verified ゼロは昇格をブロック。
4. **benchmark_scout** (LLM) + **benchmark reduce** (決定的, `.devops/db/benchmarks.js`) … ゲートスコア不足モデルのみ日次調査。LLM の結果は**提案**であり、証拠検証 (テキストは本文確認、画像は HIGH confidence) を通ったものだけ不変の事実行になる。
5. **classifier / editor** (LLM) … classifier は `classification` の最終判定、editor は日本語本文のみを `editorial.json` に書く。データ状態は一切書かない。
6. **assemble / validate / promote / deploy** (決定的, `.devops/db/assemble.js` + `publication.js`) … SQLite の候補ビューと本文から `report.json` を決定論的に組み、候補ディレクトリで検証・ビルド。全チェック通過後にのみ昇格し、コミット & プッシュ。プッシュ失敗は `validated_not_deployed` で保持。

**核心原則**: enum とランキングは LLM に書かせない。機械的に導出できるものはコードが決定的に出す。全 LLM 呼び出しは `--json-schema` / `--json-output` で縛り、スキーマ違反の実行は失敗させて前回レポートを生存させる。ベンチマークの提案は事実ではない。既存の検証済みベンチマーク行は不変。

**API 優先**: API カタログで取得できるプロバイダーはスクレイピングより API を優先。`source_cache` は実際に fetch 成功した URL だけを記録する (生成・推測 URL は成功として記録しない)。

## Data flow

`report.json` (入力) → `build/build-html.js` → `dist/index.html` (出力)。canonical の `index.html` / `og-image.png` は `npm run build` + `npm run promote:dist` でのみ更新され、手編集しない。接続手順のテキストは report.json に持たず、ビルドが `build-html.js` 内の版付きテンプレート (`AGENT_TEMPLATE_VERSION`) から生成する。エンドポイントは `build/provider-registry.json` が唯一の真実源 (公式ドキュメント由来、`delivery_type` / `api_catalog_url` を含む)。バリデータとビルドと収集スキルが共有する。ワーカーは公式ドキュメント由来の候補事実だけを提案し、決定的な取得証拠監査が候補レジストリをステージする。ワーカーが canonical registry を直接書くことはない。

## Conventions

- 単一 HTML ファイル。メニューやタブは置かない。
- ダークモードは `localStorage["theme"]` に保存し、描画前のインラインスクリプトが `prefers-color-scheme` をフォールバックに dark クラスを付与 (ちらつき防止)。
- ランキングは `ranked_offers` の `ranking_eligible === true` かつティア S/A/B のみ入門。入門には Terminal Bench 2.0 または 2.1 の検証済みスコア 50% 以上と `access_kind` (FREE/ULTRA_LOW) が必須。並びは ティア (S>A>B) → アクセス区分 (`access_kind`: FREE>ULTRA_LOW) → 同一 Terminal Bench 版のスコア降順 → `price_verified_at` 降順 → 名前。生のベンチマークスコアを異なる版・異なるベンチマーク間で比較しない。無料枠の余裕度 (`free_allowance_rank`) は表示のみで並び順に使わない。
- `ranked_offers` に入れるオファーは必ず `ranking_eligible: true`。対象外は `excluded_offers` へ (ranked に `ranking_eligible: false` で置く矛盾は禁止。ビルドがフィルタして消える)。ランキング判定・アクセス区分導出は `build/ranking-policy.js` が唯一の真実源で、assembler / validator / builder が共有する。50% 未満の Terminal Bench スコアはティア B でも決して掲載しない。
- 価格は常に「百万トークン当たりの米ドル」で保存・比較する。OpenRouter 公式カタログ (`GET /api/v1/models`) の `pricing` はトークン当たりのため、判定・保存前に必ず 1,000,000 倍する (`lanes.js` の `normalizeCatalogPrice`、migration 0004 が過去行を backfill)。LLM worker には `*_price_usd` を書かせず、`source_amount_*` と `source_unit` の生値だけを要求する。非米ドルは正の換算レート・換算情報源・換算確認日時が揃った場合だけ決定的に換算する。worker 供給の `price_verified_at` は信用せず、価格証拠の実 fetch 成功時だけ更新する。
- ベンチマークスコアは SQLite の `benchmarks` テーブルに永続化し、再生成で失わない。検証済み行は不変 (より高いスコアでも安易に上書きしない)。
- 総パラメータ 30B 未満はローカル実行領域なのでランキングしない (MoE は active ではなく総数で判定。例外: ティア S/A の競争力を持つ小型モデル)。
- ティア S/A は Terminal-Bench 2.0 または 2.1 の 50% 以上が必須。未公表・未満は掲載しない (ティア B でも掲載しない)。バリデータが強制する。
- report.json のスキーマは `.agents/skills/llm-deals-intelligence-skill/schemas/daily_report.schema.json` (draft-07)。ランキング対象オファーは `last_verified` に加え、`provider_key`、`canonical_model_id`、`access_kind` (FREE/ULTRA_LOW)、`effective_price_per_million`、`price_source`、`price_verified_at`、`endpoint_source` が必須。`free_model_names` は削除済み (spec 0004 AC-2)。
- `base_url` と `model_id` は毎回公式ドキュメントを取得して書く (記憶からの記入は禁止)。ランキング対象オファーは `endpoint_source` が必須。`npm run validate` はレジストリ整合性を検査し、引用先ページをバリデータ自身が再取得して base_url を明記していなければハードフェイルする。未登録プロバイダーはワーカーの提案を決定的証拠監査で候補化し、canonical registry への反映は昇格段階だけで行う。
- 無料アプリ/チャットアクセスは無料 API ではない (API が有料ならランキング対象外)。データ共有 opt-in の無料枠は `conditional_credits` (`F_CONDITIONAL`)。
- 収集スキルは `.agents/skills/llm-deals-intelligence-skill/`。UI 参照スキルは `.agents/skills/shadcn/` (skills-lock.json で固定)。

## State and git tracking

- **公開物 (git で追跡)**: `report.json`, `index.html`, `og-image.png`, `build/provider-registry.json` (人間が管理するレジストリ)。これだけが配布物であり、昇格時にのみ書き換わる。`index.html` / `og-image.png` は `npm run build` (出力は `dist/`) + `npm run promote:dist` でのみ更新し、手編集しない。
- **運用状態 (git で追跡しない)**: SQLite (`.agents/skills/llm-deals-intelligence-skill/state/collector.sqlite`) が唯一の運用状態。旧来の `known_offers.json` / `benchmarks.json` / `page_cache.json` は廃止済み。DB と実行ディレクトリ (manifest / artifacts / candidate / DB コピー / promotion manifest / logs) はすべてローカルのみ・`.gitignore` 対象。検証済み DB コピーが通常の復旧入力。`report.json` は非常時の bootstrap 源にすぎない。`offers.hidden` はカタログや worker が上書きしない運用者管理の公開抑止フラグで、非表示 offer は候補 report と benchmark queue から除外する。

## Notes for agents

- このファイルは最小の bootstrap。詳細な規約やエリアごとの規約は /audit または /sync で補完する。
- 設計の審議履歴とスコープ管理と検証チェックリストは `docs/` に置き、git では追跡しない。
