# デプロイ実行チェックリスト

> **使い方**: 上から順にコピペして実行するだけ。  
> `〔ここに自分で入力〕` と書かれている箇所だけ実際の値を入力してください。  
> `※ アシスタントが画面操作` と書かれているステップはブラウザ操作が必要です。

---

## 環境チェック（実行済み・参考）

| ツール | バージョン | 状態 |
|--------|-----------|------|
| Node.js | v20.20.2 | ✅ |
| npm | 10.8.2 | ✅ |
| Docker | 29.5.3 | ✅ |
| gcloud CLI | 572.0.0 | ✅ |
| gcloud ログイン | d-tanaka@studiokaren.co.jp | ✅ |
| gcloud プロジェクト | (unset) | ⚠️ → 手順1で設定 |

---

## STEP 1 — GCP プロジェクトを設定する

```bash
gcloud config set project 〔GCPプロジェクトID〕
```

> プロジェクトIDの確認方法: [GCP コンソール](https://console.cloud.google.com/) 上部に表示されている文字列（例: `studiokaren`）

設定確認:

```bash
gcloud config get-value project
```

---

## STEP 2 — 必要な API を有効化する

```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  run.googleapis.com
```

> 初回のみ。すでに有効なAPIは自動的にスキップされます。

---

## STEP 3 — Cloud Functions サービスアカウントに Secret Manager 権限を付与する

```bash
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"
```

---

## STEP 4 — Notion の準備

### 4-1. インテグレーションシークレットを取得する

※ アシスタントが画面操作:
> 1. [Notion Integrations](https://www.notion.so/my-integrations) を開く
> 2. 「GCF Notion Notify」などの名前でインテグレーションを作成（または既存のものを使用）
> 3. **「内部インテグレーションシークレット（`secret_...`）」** をコピーしておく

### 4-2. データベース ID を確認する

> お知らせデータベースをブラウザで開いたときの URL:
> ```
> https://www.notion.so/YOUR_WORKSPACE/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...
>                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
>                                      これがデータベースID（32文字）
> ```

### 4-3. データベースのプロパティを確認・追加する

※ アシスタントが画面操作:
> Notionのお知らせデータベースに以下のプロパティが存在することを確認し、なければ追加する:
>
> | プロパティ名 | 型 | 備考 |
> |-------------|-----|------|
> | `通知する` | チェックボックス | |
> | `最終通知日時` | 日付 | |
> | `締切` | 日付 | リマインダー機能で参照 |
> | `確認者` | テキスト（リッチテキスト） | 旧「既読者」をリネーム |
> | `確認数` | 数値 | 旧「既読数」をリネーム |
> | `確認者ID` | テキスト（リッチテキスト） | Slack ユーザーID をカンマ区切りで蓄積（画面非表示推奨） |

### 4-4. データベースにインテグレーションを接続する

※ アシスタントが画面操作:
> 1. お知らせデータベースを開く
> 2. 右上「**…**」→「**接続**」→ 作成したインテグレーションを選択して追加

---

## STEP 5 — Slack App の準備

### 5-1. Bot Token を取得する

※ アシスタントが画面操作:
> 1. [Slack API](https://api.slack.com/apps) を開く
> 2. 対象の App（`Notion Notify`）を選択
> 3. 左メニュー「**OAuth & Permissions**」→「**Bot Token Scopes**」に以下を追加:
>    - `chat:write`
>    - `chat:write.public`
>    - `users:read`
>    - `channels:read`（通知先がプライベートチャンネルの場合は `groups:read` も追加）
> 4. スコープ追加後「**Install to Workspace**」→ 権限を承認（**再インストール必要**）
> 5. 表示された **Bot User OAuth Token（`xoxb-...`）** をコピーしておく

### 5-2. Signing Secret を取得する

※ アシスタントが画面操作:
> 1. 左メニュー「**Basic Information**」
> 2. 「**App Credentials**」→「**Signing Secret**」をコピーしておく

---

## STEP 6 — .env ファイルを作成してシークレットを登録する

```bash
cd ~/dev/gcp/gcf-notion-slack-notify
cp .env.example .env
```

`.env` を開いて以下の値を入力する:

```bash
# エディタで .env を開く（VS Code の場合）
code .env
```

| 変数名 | 入力する値 |
|--------|-----------|
| `NOTION_TOKEN` | `secret_〔ここに自分で入力〕` |
| `NOTION_DATABASE_ID` | `〔ここに自分で入力（32文字のDB ID）〕` |
| `SLACK_BOT_TOKEN` | `xoxb-〔ここに自分で入力〕` |
| `SLACK_SIGNING_SECRET` | `〔ここに自分で入力〕` |
| `GOOGLE_CLOUD_PROJECT` | `〔STEP 1 で設定したプロジェクトID〕` |
| `GCP_PROJECT` | `〔同上〕` |
| `SLACK_CHANNEL` | `development-test`（テスト確認後に変更） |

値を入力したら Secret Manager に登録:

```bash
./register-secrets.sh
```

> 正常に完了すると最後に `gcloud secrets list` の結果が表示され、  
> `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` の4件が並びます。

---

## STEP 7 — 依存関係をインストールする

```bash
npm install
```

---

## STEP 8 — Cloud Functions にデプロイする（テスト環境）

```bash
PROJECT_ID=$(gcloud config get-value project)

gcloud functions deploy notion-slack-notify \
  --gen2 \
  --runtime nodejs20 \
  --region asia-northeast1 \
  --trigger-http \
  --entry-point notifySlack \
  --source . \
  --allow-unauthenticated \
  --timeout 60s \
  --memory 256Mi \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},SLACK_CHANNEL=development-test"
```

> デプロイには 2〜5 分かかります。

---

## STEP 9 — デプロイ後の Function URL を控える

```bash
gcloud functions describe notion-slack-notify \
  --region asia-northeast1 \
  --format='value(serviceConfig.uri)'
```

> 表示される URL（例: `https://asia-northeast1-studiokaren.cloudfunctions.net/notion-slack-notify`）を  
> **コピーして手元に保存**してください。次の2ステップで使います。

---

## STEP 10 — Slack Interactivity Request URL を設定する

※ アシスタントが画面操作:
> 1. [Slack API](https://api.slack.com/apps) → 対象 App を選択
> 2. 左メニュー「**Interactivity & Shortcuts**」
> 3. **Interactivity** を **ON**
> 4. **Request URL** に STEP 9 の URL を貼り付け:
>    ```
>    https://asia-northeast1-〔プロジェクトID〕.cloudfunctions.net/notion-slack-notify
>    ```
> 5. 「**Save Changes**」をクリック

---

## STEP 11 — Notion オートメーションを設定する

※ アシスタントが画面操作:
> 1. お知らせデータベースを開く
> 2. 右上「**…**」→「**オートメーションを追加**」
> 3. **トリガー**: 「プロパティが編集されたとき」→「通知する」→「チェックマークがオンのとき」
> 4. **アクション**: 「HTTPリクエストを送信」
>    - URL: STEP 9 の Function URL
>    - メソッド: `POST`
>    - ヘッダー: `Content-Type: application/json`
>    - ボディ: `{}`
> 5. 保存
>
> ⚠️ **既存の Notion → Slack 直接投稿オートメーションがあれば停止する（二重通知防止）**

---

## STEP 12 — 動作確認（#development-test）

### 12-1. Functionを手動で叩く

```bash
FUNCTION_URL=$(gcloud functions describe notion-slack-notify \
  --region asia-northeast1 \
  --format='value(serviceConfig.uri)')

curl -X POST "$FUNCTION_URL" && echo ""
```

> `{"message":"通知対象なし","count":0}` が返れば接続は正常です。

### 12-2. テスト通知を送る

1. Notion のお知らせ DB にテスト用行を1件作成
2. `通知する` チェックを ON にする
3. オートメーションが発火して `#development-test` に投稿されることを確認

### 12-3. 確認ポイント

- [ ] Slack に `📢 〔タイトル〕` の通知が届く
- [ ] 「✅ 確認しました」ボタンが表示されている
- [ ] 「Open in Notion」ボタンが表示されている
- [ ] 「✅ 確認しました」を押すと「〇〇が確認しました（確認済み 1人）」にメッセージが置き換わる
- [ ] Notion の `確認者` に名前が記録される
- [ ] Notion の `確認数` が 1 になる
- [ ] Notion の `確認者ID` に Slack ユーザーID が記録される
- [ ] Notion の `最終通知日時` に時刻が記録される
- [ ] 同じ行でもう一度オートメーションを発火しても **二重送信されない**

### 12-4. リマインダーの手動テスト

```bash
FUNCTION_URL=$(gcloud functions describe notion-slack-notify \
  --region asia-northeast1 \
  --format='value(serviceConfig.uri)')

# 締切が本日のお知らせに対してリマインダーを実行
curl -X GET "${FUNCTION_URL}?task=reminder" && echo ""
```

> 締切が本日のお知らせが Notion DB にあり、未確認者がいる場合に Slack へメンション付き投稿が届けば成功です。

---

## STEP 13 — 本番チャンネルへ切り替える（確認完了後）

```bash
PROJECT_ID=$(gcloud config get-value project)

gcloud functions deploy notion-slack-notify \
  --gen2 \
  --runtime nodejs20 \
  --region asia-northeast1 \
  --trigger-http \
  --entry-point notifySlack \
  --source . \
  --allow-unauthenticated \
  --timeout 60s \
  --memory 256Mi \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},SLACK_CHANNEL=general-announcements"
```

> チャンネル名以外はすべて同じコマンドです。再デプロイは 1〜2 分で完了します。

---

## STEP 14 — 再デプロイ（スコープ追加・コード変更後）

Slack スコープ追加・コード変更後は以下のコマンドで再デプロイします。

```bash
PROJECT_ID=$(gcloud config get-value project)

# テスト環境（development-test）
gcloud functions deploy notion-slack-notify \
  --gen2 \
  --runtime nodejs20 \
  --region asia-northeast1 \
  --trigger-http \
  --entry-point notifySlack \
  --source . \
  --allow-unauthenticated \
  --timeout 60s \
  --memory 256Mi \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},SLACK_CHANNEL=development-test"

# 本番環境（general-announcements）へ切り替える場合
# --set-env-vars の SLACK_CHANNEL を general-announcements に変更して実行
```

> **SLACK_CHANNEL_ID について**: `conversations.members` はチャンネルIDが必要です。  
> 指定しない場合はコードが `conversations.list` でチャンネル名からIDを自動解決します。  
> チャンネル数が多い場合やパフォーマンスを優先する場合は環境変数に追加してください:
> ```bash
> --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},SLACK_CHANNEL=general-announcements,SLACK_CHANNEL_ID=C0XXXXXXXXX"
> ```
> チャンネルIDはSlackアプリでチャンネルを右クリック →「チャンネルの詳細を表示」→ 最下部に表示されます。

---

## STEP 15 — Cloud Scheduler ジョブを作成する（リマインダー自動実行）

締切当日の JST 10:00 に自動でリマインダーを実行するジョブを作成します。

```bash
FUNCTION_URL=$(gcloud functions describe notion-slack-notify \
  --region asia-northeast1 \
  --format='value(serviceConfig.uri)')

gcloud scheduler jobs create http notion-slack-reminder \
  --location asia-northeast1 \
  --schedule "0 10 * * *" \
  --time-zone "Asia/Tokyo" \
  --uri "${FUNCTION_URL}?task=reminder" \
  --http-method GET \
  --description "毎日JST10:00に締切当日のお知らせの未確認者へリマインダーを送信"
```

> ジョブが作成済みで設定を変更する場合は `create` を `update` に変えて実行してください。  
> 手動でジョブを即時実行するには:
> ```bash
> gcloud scheduler jobs run notion-slack-reminder --location asia-northeast1
> ```

---

## トラブルシュート

| エラー | 原因・対処 |
|--------|-----------|
| `Slack API error: not_in_channel` | Bot に `chat:write.public` スコープが付いていない → STEP 5-1 を再確認 |
| `Unauthorized` (401) | `SLACK_SIGNING_SECRET` が Secret Manager に登録されていない or Interactivity URL が未設定 |
| `NOTION_DATABASE_ID not found` | `.env` の値が空か、`./register-secrets.sh` が未実行 |
| デプロイ時 `Permission denied` | STEP 3 の IAM 権限付与が未完了 |
| 確認ボタンを押しても Notion が更新されない | Notion DB に `確認者`/`確認数`/`確認者ID` プロパティが存在しない → STEP 4-3 を確認 |
| `conversations.list error: missing_scope` | Bot に `channels:read` スコープが付いていない → STEP 5-1 を再確認し再インストール |
| `conversations.members error: missing_scope` | 同上 |
| Channel "..." not found | `SLACK_CHANNEL` の値がチャンネル名と一致しているか確認、または `SLACK_CHANNEL_ID` を明示的に設定 |
