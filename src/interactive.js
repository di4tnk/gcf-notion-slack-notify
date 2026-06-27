const crypto = require('crypto');
const { markPageAsRead } = require('./notion');

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

async function handleSlackInteraction(payload) {
  const { type, actions, user, message } = payload;

  if (type === 'block_actions' && actions && actions.length > 0) {
    const action = actions[0];

    switch (action.action_id) {
      case 'mark_read': {
        const pageId = action.value;
        const userName = user.real_name || user.name || user.id;

        let readerCount = 0;
        try {
          const result = await markPageAsRead(pageId, userName);
          readerCount = result.readerCount;
        } catch (err) {
          // Notionの更新失敗はSlack側のフィードバックに影響させない
          console.error('Failed to update Notion read status:', err.message);
        }

        // 元のメッセージブロックを保持しつつ、actionsブロックをフィードバックに差し替える。
        // payload.message.blocks に元のブロック一覧が含まれている。
        const originalBlocks = message?.blocks ?? [];
        const updatedBlocks = [
          ...originalBlocks.filter(b => b.type !== 'actions'),
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `✅ *${userName}* が既読マークしました（既読 ${readerCount}人）`
            }]
          }
        ];

        return {
          response_type: 'in_channel',
          replace_original: true,
          text: `✅ ${userName} が既読マークしました（既読 ${readerCount}人）`,
          blocks: updatedBlocks
        };
      }

      case 'open_notion':
        // URLボタンのクリックはSlack側で処理される
        return {
          response_type: 'ephemeral',
          text: 'Notionページを開いています...'
        };

      default:
        return {
          response_type: 'ephemeral',
          text: '不明なアクションです'
        };
    }
  }

  return {
    response_type: 'ephemeral',
    text: 'サポートされていないインタラクションです'
  };
}

module.exports = { verifySlackRequest, handleSlackInteraction };
