# 無料LLM API速報 (free-api-news)

**毎日11:00 JST更新** — 今すぐ使える無料・激安LLM API を GitHub Pages で配信。

[🚀 サイトを見る](https://free-api-news.github.io/free-api-news/)

## 概要

このプロジェクトは、[LLM Deals Intelligence Skill](.agents/skills/llm-deals-intelligence-skill/) を使用して毎日無料・割引LLM API 情報を収集し、**1枚のHTMLページ**として GitHub Pages にデプロイします。

### 特徴

- ✅ **無料API情報** — 完全無料、恒久無料枠、試用クレジットを分類・ランキング
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
│   ├── batch/run-skill.sh        # スキル実行バッチ
│   ├── batch/collect-fallback.js # フォールバックコレクタ
│   ├── batch/install-cron.sh     # ローカル cron 登録
│   ├── deploy/build-html.sh      # HTML ビルド
│   ├── deploy/git-push.sh        # Git プッシュ
│   └── README.md                 # .devops ドキュメント
├── .agents/skills/llm-deals-intelligence-skill/  # LLM Deals Intelligence Skill
│   ├── SKILL.md                  # スキル仕様書
│   ├── config/                   # 設定ファイル
│   ├── prompts/                  # サブエージェントプロンプト
│   ├── schemas/                  # JSON スキーマ
│   └── state/                    # 前回状態
└── .gitignore
```

## クイックスタート

```bash
# 1. スキルを実行 (pi CLI が必要)
.devops/batch/run-skill.sh

# 2. HTML をビルド
.devops/deploy/build-html.sh

# 3. プレビュー
python3 -m http.server 8000
# http://localhost:8000 を開く
```

### npm スクリプト

```bash
npm run collect   # スキル実行
npm run validate  # レポート検証
npm run build     # HTML 生成
npm run deploy    # Git プッシュ
npm run full      # 全工程実行
```

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

## スキル仕様

[LLM Deals Intelligence Skill](.agents/skills/llm-deals-intelligence-skill/SKILL.md) は以下の10フェーズで無料API情報を収集します：

| フェーズ | 内容 | ツール |
|---|---|---|
| 0 | 新モデル発見 | web_search (24h/72h/30d) |
| 1 | 無料・割引検索 | web_search (EN/JA/ZH) |
| 2 | プロバイダ確認 | browser |
| 3 | コミュニティスキャン | web_search (Reddit/GitHub/HN) |
| 4 | 運用検証 | browser |
| 5 | 価格正規化 | — |
| 6 | 分類 | — |
| 7 | リスクスコア | — |
| 8 | 前回比較 | file I/O |
| 9 | レポート生成 | file I/O |

## ライセンス

© 2025 free-api-news. このサイトの情報は参考用途にお使いください。リンク先の利用規約に従ってください。
