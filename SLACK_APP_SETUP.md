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
| `users:read` | 確認ボタンを押したユーザーの表示名取得・Botユーザー除外 |
| `channels:read` | 未確認者リマインダー用のチャンネルメンバー取得（パブリックチャンネル） |
| `groups:read` | 未確認者リマインダー用のチャンネルメンバー取得（プライベートチャンネル）※通知先がプライベートの場合のみ |

> `chat:write.public` を付与することで、ボットをチャンネルに招待しなくても `#development-test` や `#general-announcements` に投稿できます。
>
> **⚠️ スコープ追加後は再インストールが必要です**: スコープを追加したら「**Install to Workspace**」ボタンが再表示されます。もう一度クリックして権限を承認してください。再インストール後に新しい Bot Token が発行される場合は `.env` の `SLACK_BOT_TOKEN` を更新し、Secret Manager にも再登録してください（`./register-secrets.sh`）。

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

送信されたメッセージの「✅ 確認しました」ボタンを押して、Notion DB の「確認者」「確認数」「確認者ID」が更新されることを確認してください。

---

## インタラクティブ機能

| ボタン | 動作 |
|--------|------|
| **✅ 確認しました** | Notion の「確認者」に押した人の名前を追記、「確認数」を +1、「確認者ID」にSlackユーザーIDを追記、Slackメッセージを「〇〇が確認しました（確認済み N人）」に置換 |
| **Open in Notion** | Notion ページを直接開く |

---

## リマインダー機能（Cloud Scheduler 連携）

締切当日に未確認者へ自動メンションを送る機能です。

- **エンドポイント**: `GET/POST {FUNCTION_URL}?task=reminder`
- **Cloud Scheduler**: 毎日 JST 10:00 に上記 URL を叩くジョブを設定（詳細は DEPLOY.md 参照）
- **動作**: Notion の「締切」が本日のお知らせを取得し、チャンネルメンバーのうち「確認者ID」に未登録の人に個別メンションを投稿

送信されたメッセージの「✅ 確認しました」ボタンを押して、Notion DB の「確認者」「確認数」「確認者ID」が更新されることを確認してください。
