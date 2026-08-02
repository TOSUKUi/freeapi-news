# LLM Deals Intelligence Skill

AIエージェントに、高性能LLMの無料枠・期間限定無料・大幅割引・条件付きクレジットを毎日調査させるためのSkill一式です。

## Files

- `SKILL.md`: 実行ルールと受入基準
- `schemas/`: 構造化出力スキーマ (crawl-facts, benchmark-scout, classifications, editorial, daily_report)
- `prompts/`: ワーカー役割プロンプト (crawl-worker, discovery-agent, benchmark-scout, classifier-agent, editor-agent)
- `state/collector.sqlite`: 唯一の運用状態 (ローカルのみ・git 管理外)
- `examples/sample_report.md`: 日本語レポート雛形

## Recommended execution

プロジェクトルートの `.devops/db/collect.js` がパイプライン全体を駆動します (`npm run collect` / `npm run full`)。
この Skill のプロンプトとスキーマは、そのパイプラインが起動する LLM ワーカーの役割契約です。

1. catalog (決定的コード) + known_refresh / discovery ワーカー
2. benchmark scout ワーカー (提案は証拠検証後に事実化)
3. classifier / editor ワーカー (分類と日本語本文)
4. 決定的アセンブリ → 候補検証 → 昇格 → デプロイ

## Minimum tool requirements

- web search
- browser/page fetch
- GitHub search
- Reddit search
- persistent file storage

## Safety

無料・激安プロバイダーへ機密情報を送らないこと。検証時にCookie、セッショントークン、他社APIキーを要求するサービスは除外してください。
