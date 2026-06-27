# gcf-notion-slack-notify

Notionの「お知らせ」データベースで「通知する」チェックをONにしたページを Slack に通知する Google Cloud Functions（Node.js）。

## 機能

- ✅ 「通知する=ON かつ 最終通知日時が空（未通知）」のページのみ送信（重複送信ガード）
- ✅ 送信後に Notion の「最終通知日時」を自動更新
- ✅ 「お知らせ」プロパティの内容をタイトルとして使用
- ✅ `@channel` メンション付き Slack 通知
- ✅ インタラクティブボタン（✅ 既読 / Open in Notion）
- ✅ 既読ボタン押下で Notion の「既読者」「既読数」を更新
- ✅ `SLACK_CHANNEL` 環境変数でテスト／本番チャンネルを切り替え
- ✅ Google Cloud Secret Manager 連携
- ✅ Docker 開発環境

## クイックスタート

```bash
# 1. 依存関係インストール
npm install

# 2. 環境変数設定
cp .env.example .env
# .env を編集して実際の値を入力

# 3. ローカル起動
docker-compose up --build

# 4. テストリクエスト
curl -X POST http://localhost:8080/
```

## ファイル構成

```
├── src/
│   ├── index.js       # Cloud Functions エントリポイント
│   ├── notion.js      # Notion API 処理（取得・最終通知日時更新・既読更新）
│   ├── slack.js       # Slack 通知処理（Bot Token + chat.postMessage）
│   └── interactive.js # インタラクティブボタン処理
├── .env.example       # 環境変数テンプレート
├── docker-compose.yml # 開発環境
├── Dockerfile
├── register-secrets.sh  # Secret Manager 一括登録スクリプト
├── DEPLOY.md          # デプロイ手順書（詳細）
└── SLACK_APP_SETUP.md # Slack App 設定手順
```

## Notion DB の必須プロパティ

| プロパティ名 | 型 | 説明 |
|-------------|-----|------|
| `通知する` | チェックボックス | 通知トリガー |
| `最終通知日時` | 日付 | 重複送信防止（空=未通知） |
| `既読者` | テキスト | 既読した人の名前 |
| `既読数` | 数値 | 既読人数 |

プロパティ名を変えている場合は `.env` の `NOTION_*_PROPERTY` 変数で対応できます。

## 通知チャンネルの切り替え

```bash
# テスト（デフォルト）
SLACK_CHANNEL=development-test

# 本番
SLACK_CHANNEL=general-announcements
```

## デプロイ

詳細は [DEPLOY.md](./DEPLOY.md) を参照してください。

## Slack App 設定

詳細は [SLACK_APP_SETUP.md](./SLACK_APP_SETUP.md) を参照してください。

## 必要なシークレット

| 変数名 | 取得元 |
|--------|--------|
| `NOTION_TOKEN` | Notion インテグレーション設定 |
| `NOTION_DATABASE_ID` | Notion DB の URL |
| `SLACK_BOT_TOKEN` | Slack App > OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | Slack App > Basic Information |

## ライセンス

MIT
