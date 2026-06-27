#!/bin/bash

# .envファイルからSecret Managerにシークレットを登録するスクリプト
# 使用前に: gcloud auth login && gcloud config set project YOUR_PROJECT_ID

set -e

echo "Starting secret registration from .env file..."

if [ ! -f ".env" ]; then
    echo "Error: .env file not found!"
    echo "cp .env.example .env を実行してから値を入力してください。"
    exit 1
fi

register_or_update_secret() {
  local key="$1"
  local value="$2"

  if gcloud secrets describe "$key" &>/dev/null 2>&1; then
    echo "  Updating existing secret: $key"
    echo -n "$value" | gcloud secrets versions add "$key" --data-file=-
  else
    echo "  Creating new secret: $key"
    echo -n "$value" | gcloud secrets create "$key" --data-file=-
  fi

  if [ $? -eq 0 ]; then
    echo "  ✅ $key registered"
  else
    echo "  ❌ Failed to register $key"
  fi
}

while IFS='=' read -r key value; do
  # コメント行・空行・変数参照行をスキップ
  [[ "$key" =~ ^#.*$ ]] || [[ -z "$key" ]] && continue
  # 値から引用符と余分な空白を除去
  value=$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^"//;s/"$//')

  case $key in
    NOTION_TOKEN|NOTION_DATABASE_ID|SLACK_BOT_TOKEN|SLACK_SIGNING_SECRET)
      echo "Registering $key..."
      register_or_update_secret "$key" "$value"
      ;;
  esac
done < .env

echo ""
echo "Registration completed. Listing secrets:"
gcloud secrets list
