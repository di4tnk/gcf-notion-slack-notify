const axios = require('axios');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { updateLastNotifiedAt, getAnnouncementsWithDeadlineToday } = require('./notion');

let secretManagerClient = null;

async function getSecret(secretName) {
  if (!secretManagerClient) {
    secretManagerClient = new SecretManagerServiceClient();
  }
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'studiokaren';
  const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
  const [version] = await secretManagerClient.accessSecretVersion({ name });
  return version.payload.data.toString();
}

async function getSlackBotToken() {
  return process.env.SLACK_BOT_TOKEN || await getSecret('SLACK_BOT_TOKEN');
}

// チャンネルは SLACK_CHANNEL 環境変数で切り替え可能
// テスト: development-test / 本番: general-announcements
function getSlackChannel() {
  return process.env.SLACK_CHANNEL || 'development-test';
}

function buildNotificationBlocks(page) {
  const blocks = [];

  // ① @channel ヘッダー
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `<!channel> *システム*が *:bulb: お知らせ* へ追加しました` }
  });

  // ② タイトル行（種別・重要度タグ付き） + Open in Notion ボタン
  const metaTags = [];
  if (page.kind) metaTags.push(`種別: *${page.kind}*`);
  if (page.importance) metaTags.push(`重要度: *${page.importance}*`);
  const metaLine = metaTags.length > 0 ? `\n${metaTags.join('　｜　')}` : '';

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${page.title}*${metaLine}` },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: 'Open in Notion', emoji: true },
      value: page.id,
      url: page.url,
      action_id: 'open_notion'
    }
  });

  // ③ 本文要点（取得できた場合のみ）
  if (page.body && page.body.trim()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: page.body }
    });
  }

  // ④ 区切り線
  blocks.push({ type: 'divider' });

  // ⑤ 確認ボタンの注記
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '※内容を読んだら「確認しました」ボタンを押してください。確認状況はNotionに記録されます。'
    }]
  });

  // ⑥ 確認ボタン（value に Notion ページ ID をセット）
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ 確認しました', emoji: true },
        value: page.id,
        action_id: 'mark_read',
        style: 'primary'
      }
    ]
  });

  return blocks;
}

async function sendSlackMessage(botToken, channel, page) {
  const payload = {
    channel,
    text: `📢 お知らせ: ${page.title}`,  // プッシュ通知 / フォールバックテキスト
    blocks: buildNotificationBlocks(page)
  };

  const response = await axios.post('https://slack.com/api/chat.postMessage', payload, {
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });

  if (!response.data.ok) {
    throw new Error(`Slack API error: ${response.data.error}`);
  }

  return { success: true, ts: response.data.ts, channel: response.data.channel };
}

async function sendSlackNotifications(pages) {
  const botToken = await getSlackBotToken();
  const channel = getSlackChannel();
  console.log(`Sending to channel: ${channel}`);
  const results = [];

  for (const page of pages) {
    console.log(`Sending notification for: ${page.title}`);
    try {
      const result = await sendSlackMessage(botToken, channel, page);

      // 送信成功後に最終通知日時を書き込む（重複送信ガード）
      try {
        await updateLastNotifiedAt(page.id);
      } catch (notionError) {
        console.error(`Failed to update 最終通知日時 for ${page.id}:`, notionError.message);
      }

      results.push({ pageId: page.id, title: page.title, ...result });
      console.log(`Successfully sent notification for: ${page.title}`);
    } catch (error) {
      console.error(`Failed to send notification for: ${page.title} — ${error.message}`);
      results.push({ pageId: page.id, title: page.title, success: false, error: error.message });
    }
  }

  return results;
}

// チャンネル名からチャンネルIDを解決する（conversations.list を使用）
// SLACK_CHANNEL_ID 環境変数が設定されていればそちらを優先する
async function resolveChannelId(botToken, channelName) {
  const envId = process.env.SLACK_CHANNEL_ID;
  if (envId) return envId;

  // チャンネル名がすでにID形式（C から始まる英数字）の場合はそのまま返す
  if (/^[A-Z0-9]{8,}$/.test(channelName)) return channelName;

  let cursor;
  do {
    const params = { limit: 200, types: 'public_channel,private_channel' };
    if (cursor) params.cursor = cursor;
    const res = await axios.get('https://slack.com/api/conversations.list', {
      headers: { Authorization: `Bearer ${botToken}` },
      params
    });
    if (!res.data.ok) throw new Error(`conversations.list error: ${res.data.error}`);
    const found = res.data.channels.find(c => c.name === channelName);
    if (found) return found.id;
    cursor = res.data.response_metadata?.next_cursor;
  } while (cursor);

  throw new Error(`Channel "${channelName}" not found via conversations.list`);
}

// チャンネルの全メンバーIDを取得する（ページネーション対応）
async function getChannelMembers(botToken, channelId) {
  const members = [];
  let cursor;
  do {
    const params = { channel: channelId, limit: 200 };
    if (cursor) params.cursor = cursor;
    const res = await axios.get('https://slack.com/api/conversations.members', {
      headers: { Authorization: `Bearer ${botToken}` },
      params
    });
    if (!res.data.ok) throw new Error(`conversations.members error: ${res.data.error}`);
    members.push(...res.data.members);
    cursor = res.data.response_metadata?.next_cursor;
  } while (cursor);
  return members;
}

// Bot・削除済みユーザーのIDセットを取得する（除外フィルタ用）
async function getBotAndDeletedUserIds(botToken) {
  const excludeIds = new Set();
  let cursor;
  do {
    const params = { limit: 200 };
    if (cursor) params.cursor = cursor;
    const res = await axios.get('https://slack.com/api/users.list', {
      headers: { Authorization: `Bearer ${botToken}` },
      params
    });
    if (!res.data.ok) throw new Error(`users.list error: ${res.data.error}`);
    for (const u of res.data.members) {
      if (u.is_bot || u.deleted) excludeIds.add(u.id);
    }
    cursor = res.data.response_metadata?.next_cursor;
  } while (cursor);
  return excludeIds;
}

// 締切が本日のお知らせについて、未確認者へ個別メンションでリマインドを投稿する
async function sendReminderNotifications() {
  const botToken = await getSlackBotToken();
  const channelName = getSlackChannel();

  const pages = await getAnnouncementsWithDeadlineToday();
  if (pages.length === 0) {
    console.log('No announcements with deadline today — nothing to remind');
    return { remindedCount: 0, results: [] };
  }

  const channelId = await resolveChannelId(botToken, channelName);
  const [members, excludeIds] = await Promise.all([
    getChannelMembers(botToken, channelId),
    getBotAndDeletedUserIds(botToken)
  ]);

  const humanMembers = members.filter(uid => !excludeIds.has(uid));
  console.log(`Channel ${channelId}: ${humanMembers.length} human members`);

  const results = [];
  for (const page of pages) {
    const confirmedSet = new Set(page.confirmedIds);
    const unconfirmed = humanMembers.filter(uid => !confirmedSet.has(uid));

    if (unconfirmed.length === 0) {
      console.log(`All members confirmed "${page.title}" — skipping reminder`);
      results.push({ pageId: page.id, title: page.title, skipped: true });
      continue;
    }

    const mentions = unconfirmed.map(uid => `<@${uid}>`).join(' ');
    const text = `⏰【確認のお願い】「${page.title}」の確認期限は本日です。\n未確認: ${mentions}\nお手数ですが内容をご確認の上、対象の投稿の「確認しました」ボタンを押してください。`;

    const res = await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channelId,
      text
    }, {
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    });

    if (!res.data.ok) throw new Error(`chat.postMessage (reminder) error: ${res.data.error}`);

    console.log(`Sent reminder for "${page.title}" to ${unconfirmed.length} unconfirmed members`);
    results.push({ pageId: page.id, title: page.title, unconfirmedCount: unconfirmed.length, success: true });
  }

  return { remindedCount: results.filter(r => r.success).length, results };
}

module.exports = { sendSlackNotifications, buildNotificationBlocks, sendReminderNotifications };
