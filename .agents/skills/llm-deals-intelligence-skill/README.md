# LLM Deals Intelligence Skill

AIエージェントに、高性能LLMの無料枠・期間限定無料・大幅割引・条件付きクレジットを毎日調査させるためのSkill一式です。

## Files

- `SKILL.md`: 実行ルールと受入基準
- `config/sources.yaml`: 常時確認する情報源
- `config/search_queries.yaml`: 多言語検索語
- `schemas/daily_report.schema.json`: 構造化出力スキーマ
- `prompts/`: サブエージェント別プロンプト
- `state/known_offers.json`: 前日比較用の初期状態
- `examples/sample_report.md`: 日本語レポート雛形

## Recommended execution

1. Discovery Agent
2. Offer Agent
3. Verification Agent
4. Editor Agent
5. JSON Schema validation
6. Save new state

## Minimum tool requirements

- web search
- browser/page fetch
- GitHub search
- Reddit search
- persistent file storage

## Safety

無料・激安プロバイダーへ機密情報を送らないこと。検証時にCookie、セッショントークン、他社APIキーを要求するサービスは除外してください。
