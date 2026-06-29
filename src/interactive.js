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

// 確認済みコンテキストブロック（"確認済み N人"）から現在のカウントを取得する
function extractConfirmedCount(blocks) {
  for (const block of blocks ?? []) {
    if (block.type !== 'context') continue;
    for (const el of block.elements ?? []) {
      const m = (el.text ?? '').match(/確認済み\s*(\d+)\s*人/);
      if (m) return parseInt(m[1], 10);
    }
  }
  return 0;
}

// 確認状態のブロック列を構築する。
// 既存の確認状態 context のみ置換し、actions（ボタン）は必ず残す。
// ボタンを残すことで複数人が順に押せる。
function buildConfirmedBlocks(originalBlocks, displayName, count) {
  const filtered = originalBlocks.filter(b => {
    if (b.type === 'context') {
      const isConfirmStatus = (b.elements ?? []).some(
        el => (el.text ?? '').includes('確認済み') && (el.text ?? '').includes('人')
      );
      if (isConfirmStatus) return false;
    }
    return true;
  });
  return [
    ...filtered,
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `✅ *${displayName}* が確認しました（確認済み ${count}人）`
      }]
    }
  ];
}

// Slackインタラクションを処理し、response_url 経由でメッセージを更新する。
// index.js が res.status(200).send('') で即座にSlackへ応答した後に呼ばれる想定。
// オプティミスティックUI: API呼び出しを待たずに即座にメッセージを更新し、
// Notion書き込み完了後に確定値で整合（失敗時は元に戻してエラーを通知）。
async function handleSlackInteraction(payload) {
  const { type, actions, user, message, response_url } = payload;

  if (type !== 'block_actions' || !actions?.length) return;

  const action = actions[0];

  if (action.action_id === 'mark_read') {
    const pageId = action.value;

    if (!response_url) {
      console.warn('No response_url in payload — cannot update Slack message');
      return;
    }

    const originalBlocks = message?.blocks ?? [];

    // ① 楽観的更新（API呼び出しなしで即座に送信）
    // payload の user から仮の表示名を作る（users.info の往復を待たない）
    const optimisticName = user.name || user.username || user.id;
    const currentCount = extractConfirmedCount(originalBlocks);
    const optimisticCount = currentCount + 1;

    try {
      await axios.post(response_url, {
        response_type: 'in_channel',
        replace_original: true,
        text: `✅ ${optimisticName} が確認しました（確認済み ${optimisticCount}人）`,
        blocks: buildConfirmedBlocks(originalBlocks, optimisticName, optimisticCount)
      });
      console.log(`Optimistic update sent (user: ${optimisticName}, count: ${optimisticCount})`);
    } catch (err) {
      console.warn('Failed to send optimistic update:', err.message);
    }

    // ② 非同期: 正式な表示名を取得（users.info — users:read スコープ必要）
    const payloadFallback = user.name || user.username || user.id;
    const userName = await fetchSlackDisplayName(user.id, payloadFallback);

    // ③ Notion 確定書き込み（冪等: 連打しても確認数は増えない）
    let notionResult;
    try {
      notionResult = await markPageAsConfirmed(pageId, userName, user.id);
    } catch (err) {
      console.error('Failed to update Notion confirmation status:', err.message);
      // 書き込み失敗: ephemeral エラー通知 + 楽観更新を取り消して元に戻す
      try {
        await axios.post(response_url, {
          response_type: 'ephemeral',
          replace_original: false,
          text: '⚠️ 確認の記録に失敗しました。もう一度押してください。'
        });
      } catch (e) {
        console.warn('Failed to send error ephemeral:', e.message);
      }
      try {
        await axios.post(response_url, {
          response_type: 'in_channel',
          replace_original: true,
          text: 'お知らせ',
          blocks: originalBlocks
        });
      } catch (e) {
        console.warn('Failed to revert optimistic update:', e.message);
      }
      return;
    }

    // ④ 確定値（正式名・Notion確定カウント）でメッセージを整合
    // 楽観表示との差（名前の表記、冪等による数の違い）をここで吸収する
    const { readerCount } = notionResult;
    try {
      await axios.post(response_url, {
        response_type: 'in_channel',
        replace_original: true,
        text: `✅ ${userName} が確認しました（確認済み ${readerCount}人）`,
        blocks: buildConfirmedBlocks(originalBlocks, userName, readerCount)
      });
      console.log(`Message reconciled (page: ${pageId}, user: ${userName}, count: ${readerCount})`);
    } catch (err) {
      console.error('Failed to reconcile Slack message:', err.message);
    }
  }

  // open_notion はURLボタンのためSlack側で自動処理、応答不要
}

module.exports = { verifySlackRequest, handleSlackInteraction };
