# 無料LLM API速報 (free-api-news)

**毎日11:00 JST更新** — 今すぐ使える無料・激安LLM API を GitHub Pages で配信。

[🚀 サイトを見る](https://freeapi-news.tosukui.xyz/)

## 概要

このプロジェクトは、[LLM Deals Intelligence Skill](.agents/skills/llm-deals-intelligence-skill/) を使用して毎日無料・激安LLM API 情報を収集し、**1枚のHTMLページ**として GitHub Pages にデプロイします。

### 特徴

- ✅ **無料・激安API情報** — 完全無料、恒久無料枠、試用クレジット、激安 API を分類・ランキング
- ✅ **リンク付き** — すべてのAPIに公式ページへのリンク
- ✅ **5分で使える** — pi / Claude Code / OpenCode / Codex の設定方法を記載
- ✅ **登録手順** — アカウント作成からテスト呼び出しまで4ステップ
- ✅ **毎日自動更新** — ローカル cron で 11:00 JST に更新 (CI 不使用)
- ✅ **ダークモード** — 目に優しいダークモード対応
- ✅ **レスポンシブ** — モバイル・デスクトップ両対応

## プロジェクト構造

```
free-api-news/
├── index.html                    # GitHub Pages ページ (自動生成)
├── report.json                   # スキルの出力レポート (自動生成)
├── package.json                  # npm スクリプト
├── build/
│   ├── build-html.js             # JSON → HTML ジェネレータ
│   └── validate-report.js        # JSON スキーマバリデータ
├── .devops/
│   ├── config/env.sh             # 環境設定
│   ├── db/cli.js                 # SQLite コレクタ CLI (収集〜公開の入口)
│   ├── db/collect.js             # フェイルセーフ収集オーケストレータ
│   ├── db/collector-db.js        # node:sqlite ステートストア
│   ├── db/lanes.js / benchmarks.js / assemble.js / catalog.js / publication.js
│   ├── batch/install-cron.sh     # ローカル cron 登録
│   └── README.md                 # .devops ドキュメント
├── .agents/skills/llm-deals-intelligence-skill/  # LLM Deals Intelligence Skill
│   ├── SKILL.md                  # スキル仕様書
│   ├── prompts/                  # ワーカー役割プロンプト
│   ├── schemas/                  # JSON スキーマ
│   └── state/                    # SQLite 運用状態 (ローカルのみ・git 管理外)
└── .gitignore
```

## クイックスタート

```bash
# 1. 収集 → 検証 → ローカル昇格 (プッシュしない。pi CLI が必要)
npm run collect

# 2. プレビュー
python3 -m http.server 8000
# http://localhost:8000 を開く

# 3. 公開 (昇格済み世代をコミット & プッシュ)
npm run deploy
```

### npm スクリプト

```bash
npm run collect          # 収集 → 候補検証 → ローカル昇格 (プッシュしない)
npm run collect:dry-run  # 収集 → 候補検証 (昇格・デプロイしない。経路の確認用)
npm run deploy           # 最後に昇格した世代をコミット & プッシュ
npm run full             # 収集 → 昇格 → デプロイを一括
npm run validate         # 現行の公開スナップショットを検証
npm run build            # 現行の公開スナップショットから dist/ へ HTML/OG 生成 (canonical は触らない)
npm run promote:dist     # 生成済み dist/ を公開位置 (index.html / og-image.png) へ反映
npm run db:status        # SQLite スキーマ・実行状態を表示
npm test                 # コレクタのフィクスチャテスト
```

収集は SQLite (`.agents/skills/llm-deals-intelligence-skill/state/collector.sqlite`) を
唯一の運用状態として使います。この DB と実行ディレクトリは git 管理外です。
失敗した実行は前回公開を壊さず、昇格は全チェック通過後に初めて現行ファイルを書き換えます。

## ローカル定期実行 (cron)

収集 → 検証 → ビルド → デプロイは **1 台のマシンで完結**します。pi が `browser` (camofox) と
`web_search` を必要とするため、CI ではなくこれらが揃ったローカルマシンで実行します。

```bash
# cron 行を確認
.devops/batch/install-cron.sh

# crontab に登録 (冪等)
.devops/batch/install-cron.sh --install
```

- スケジュールはマシンのローカル時刻です。11:00 JST にしたいならマシンを `Asia/Tokyo` に。
- cron は PATH が狭いため、`install-cron.sh` はログインシェル (`bash -lc`) 経由で
  `npm run full` を呼びます (nodenv/nvm 等の PATH を読み込むため)。
- 収集が失敗すると `npm run full` はデプロイ前に停止します (生成物のプッシュなし)。
- ログは `.devops/logs/batch.log`。

## GitHub Pages デプロイ

GitHub Actions は使いません。生成物 (`report.json` + `index.html`) はそのまま
`master` にコミットされ、Pages は `master` ブランチから配信されます。

1. このリポジトリを GitHub にプッシュ (例: `free-api-news/free-api-news`)
2. Settings → Pages → Source: **Deploy from a branch** → `master` / `/ (root)`
3. ローカル cron が毎日 11:00 JST に `npm run full` を実行し `master` へプッシュ → Pages 反映

## 収集パイプライン

[LLM Deals Intelligence Skill](.agents/skills/llm-deals-intelligence-skill/SKILL.md) と
`.devops/db/` の決定論的コードが役割を分担します。機械的な作業 (カタログ取得・状態管理・
ランキング組み立て) はコードが担い、LLM は事実の抽出と分類・日本語執筆だけを行います。

| 段階 | 内容 | 担当 |
|---|---|---|
| catalog | OpenRouter 等の公式カタログを API から決定論的に取得 | コード |
| known_refresh | 既知オファーの公式ページを再取得して検証 | LLM ワーカー |
| discovery | 新規発表モデルの探索 (失敗しても既知オファーに影響しない) | LLM ワーカー |
| benchmark_scout | ゲートスコア不足モデルのベンチマーク調査 (提案は検証後にのみ事実化) | LLM ワーカー |
| reduce / assemble | ライブネス・ティア・ランキングを決定論的に導出しレポートを組み立て | コード |
| classifier / editor | 分類の最終判定と日本語本文の執筆 | LLM ワーカー |
| validate / promote / deploy | 候補検証 → 昇格 → コミット & プッシュ (失敗時は前回公開を維持) | コード |

## ライセンス

© 2026 free-api-news. このサイトの情報は参考用途にお使いください。リンク先の利用規約に従ってください。
