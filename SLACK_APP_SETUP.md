# Slack App 設定手順

## 概要

このシステムは **Incoming Webhook ではなく Slack Bot Token** を使用します。  
Bot Token 方式にすることで `SLACK_CHANNEL` 環境変数だけで通知先チャンネルを切り替えられます。

---

## 1. Slack App の作成

1. [Slack API](https://api.slack.com/apps) にアクセスし **「Create New App」→「From scratch」**
2. **App Name**: `Notion Notify`（任意）
3. ワークスペースを選択して作成

---

## 2. Bot Token Scopes の設定（重要）

1. 左メニュー「**OAuth & Permissions**」を選択
2. 「**Scopes**」セクションの「**Bot Token Scopes**」に以下を追加：

| Scope | 用途 |
|-------|------|
| `chat:write` | チャンネルへのメッセージ投稿 |
| `chat:write.public` | ボットが参加していないパブリックチャンネルへの投稿 |

> `chat:write.public` を付与することで、ボットをチャンネルに招待しなくても `#development-test` や `#general-announcements` に投稿できます。

3. 「**Install to Workspace**」→ 権限を承認
4. 「**Bot User OAuth Token**（`xoxb-...`）」をコピーして `.env` の `SLACK_BOT_TOKEN` に設定

---

## 3. Interactivity（既読ボタン）の設定

1. 左メニュー「**Interactivity & Shortcuts**」を選択
2. 「**Interactivity**」を **ON**
3. **Request URL** にデプロイ後の Cloud Functions URL を設定：
   ```
   https://REGION-PROJECT_ID.cloudfunctions.net/notion-slack-notify
   ```
   例: `https://asia-northeast1-studiokaren.cloudfunctions.net/notion-slack-notify`

4. 「**Save Changes**」

> **注意**: ローカル開発中に既読ボタンをテストする場合は [ngrok](https://ngrok.com/) などで `http://localhost:8080` をトンネルし、そのURLを設定してください。

---

## 4. Signing Secret の取得

1. 左メニュー「**Basic Information**」を選択
2. 「**App Credentials**」セクションの「**Signing Secret**」をコピー
3. `.env` の `SLACK_SIGNING_SECRET` に設定
4. Secret Manager にも登録: `./register-secrets.sh`

---

## 5. 通知チャンネルの切り替え

| 環境 | `SLACK_CHANNEL` の値 |
|------|---------------------|
| テスト | `development-test` |
| 本番 | `general-announcements` |

`.env` の `SLACK_CHANNEL` を変更するだけで切り替えできます。GCF デプロイ時は `--set-env-vars SLACK_CHANNEL=general-announcements` で指定します。

---

## 6. 動作確認

```bash
# ローカル
curl -X POST http://localhost:8080/

# テスト送信（ダミーページを用意して確認）
```

送信されたメッセージの「✅ 既読」ボタンを押して、Notion DB の「既読者」「既読数」が更新されることを確認してください。

---

## インタラクティブ機能

| ボタン | 動作 |
|--------|------|
| **✅ 既読** | Notion の「既読者」に押した人の名前を追記、「既読数」を +1、Slackメッセージを「〇〇が既読マークしました」に置換 |
| **Open in Notion** | Notion ページを直接開く |
