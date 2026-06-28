const crypto = require('crypto');
const axios = require('axios');
const { markPageAsConfirmed } = require('./notion');

// Slack署名検証。GCFはreq.rawBodyを提供するのでrawBodyStringを渡すこと
function verifySlackRequest(rawBodyString, timestamp, signature) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signingSecret) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('SLACK_SIGNING_SECRET not set — skipping verification in dev mode');
      return true;
    }
    console.error('SLACK_SIGNING_SECRET is not configured');
    return false;
  }

  if (!timestamp || !signature) return false;

  const baseString = `v0:${timestamp}:${rawBodyString}`;
  const computedSignature = `v0=${crypto
    .createHmac('sha256', signingSecret)
    .update(baseString)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(computedSignature, 'utf8')
    );
  } catch {
    return false;
  }
}

// users.info API で表示名を取得する。
// 取得優先順位: profile.display_name → real_name → name → username → id
// users:read スコープが必要。スコープ未付与・APIエラー時は fallback を返す。
async function fetchSlackDisplayName(userId, fallback) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn('SLACK_BOT_TOKEN not set — cannot call users.info');
    return fallback;
  }

  try {
    const res = await axios.get('https://slack.com/api/users.info', {
      headers: { Authorization: `Bearer ${botToken}` },
      params: { user: userId }
    });

    if (!res.data.ok) {
      console.warn(`users.info error: ${res.data.error} — falling back to "${fallback}"`);
      return fallback;
    }

    const profile = res.data.user?.profile;
    const u = res.data.user;

    // 優先順位: real_name → profile.display_name → name → id
    // real_name を先にする理由: display_name はハンドル名がそのまま入っている場合があり、
    // real_name のほうが人間に読みやすい正式名（例: 田中 大輔）を持つことが多いため。
    // 空文字は飛ばして最初に値があるものを採用。
    const candidates = [
      u?.real_name,
      profile?.display_name,
      u?.name,
      u?.id
    ];
    const displayName = candidates.find(v => v && v.trim() !== '');
    console.log(`users.info — real_name:"${u?.real_name}" display_name:"${profile?.display_name}" → adopted:"${displayName}"`);
    return displayName || fallback;

  } catch (err) {
    console.warn(`Failed to call users.info: ${err.message} — falling back to "${fallback}"`);
    return fallback;
  }
}

// Slackインタラクションを処理し、response_url 経由でメッセージを更新する。
// index.js が res.status(200).send('') で即座にSlackへ応答した後に呼ばれる想定。
async function handleSlackInteraction(payload) {
  const { type, actions, user, message, response_url } = payload;

  if (type !== 'block_actions' || !actions?.length) return;

  const action = actions[0];

  // block_actions ペイロードの user オブジェクトは id / username / name / team_id のみ。
  // real_name はペイロードに含まれないため users.info API で取得する（users:read スコープ必要）。
  // API失敗時は payload の user.name にフォールバック。
  const payloadFallback = user.name || user.username || user.id;
  const userName = await fetchSlackDisplayName(user.id, payloadFallback);

  if (action.action_id === 'mark_read') {
    const pageId = action.value;

    // Notionの確認者（表示名ベース重複チェック含む）・確認数・確認者IDを更新
    let readerCount = 0;
    try {
      const result = await markPageAsConfirmed(pageId, userName, user.id);
      readerCount = result.readerCount;
    } catch (err) {
      console.error('Failed to update Notion confirmation status:', err.message);
    }

    // 元のブロックから actions を除去し、context フィードバックを末尾に追加
    const originalBlocks = message?.blocks ?? [];
    const updatedBlocks = [
      ...originalBlocks.filter(b => b.type !== 'actions'),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `✅ *${userName}* が確認しました（確認済み ${readerCount}人）`
        }]
      }
    ];

    // response_url に POST してSlackメッセージを更新
    // (HTTPレスポンスボディではなくこちらが確実に反映される)
    if (!response_url) {
      console.warn('No response_url in payload — cannot update Slack message');
      return;
    }

    try {
      await axios.post(response_url, {
        response_type: 'in_channel',
        replace_original: true,
        text: `✅ ${userName} が確認しました（確認済み ${readerCount}人）`,
        blocks: updatedBlocks
      });
      console.log(`Slack message updated via response_url (page: ${pageId}, user: ${userName}, count: ${readerCount})`);
    } catch (err) {
      console.error('Failed to update Slack message via response_url:', err.message);
    }
  }

  // open_notion はURLボタンのためSlack側で自動処理、応答不要
}

module.exports = { verifySlackRequest, handleSlackInteraction };
