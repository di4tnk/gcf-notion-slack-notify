const functions = require('@google-cloud/functions-framework');
const { getNotionPages, getPageById, extractPageIdFromWebhookPayload } = require('./notion');
const { sendSlackNotifications } = require('./slack');
const { verifySlackRequest, handleSlackInteraction } = require('./interactive');

functions.http('notifySlack', async (req, res) => {
  // Slackインタラクティブ要素の処理（ボタンクリック時）
  if (req.method === 'POST' && req.body && req.body.payload) {
    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];

    // GCFはreq.rawBodyを提供する。ローカルdevではurlencoded形式に再構築する。
    const rawBody = req.rawBody
      ? req.rawBody.toString('utf8')
      : new URLSearchParams(req.body).toString();

    if (!verifySlackRequest(rawBody, timestamp, signature)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let payload;
    try {
      payload = JSON.parse(req.body.payload);
    } catch (err) {
      console.error('Failed to parse interaction payload:', err.message);
      return res.status(400).json({ error: 'Bad request' });
    }

    // Slackは3秒以内のレスポンスを要求するため先に200を返し、非同期で処理する
    res.status(200).send('');
    handleSlackInteraction(payload).catch(err => {
      console.error('Error in handleSlackInteraction:', err);
    });
    return;
  }

  // 通知処理: Notionボタン（Webhookを送信する）または手動トリガー
  try {
    console.log('Starting notification process...');
    console.log('Request body:', JSON.stringify(req.body));

    let pages;
    const pageId = extractPageIdFromWebhookPayload(req.body);

    if (pageId) {
      // ページID取得成功: そのページのみ対象（最終通知日時が空の場合のみ通知）
      console.log(`Webhook mode: processing page ${pageId}`);
      const page = await getPageById(pageId);
      if (!page) {
        return res.status(200).json({ message: '通知済みまたはページが見つかりません', count: 0 });
      }
      pages = [page];
    } else {
      // フォールバック: 最終通知日時が空のページをDBクエリで取得
      console.log('Fallback mode: querying unnotified pages from database');
      pages = await getNotionPages();
    }

    if (pages.length === 0) {
      console.log('No pages to notify');
      return res.status(200).json({ message: '通知対象なし', count: 0 });
    }

    console.log(`Sending notifications for ${pages.length} page(s)`);
    const results = await sendSlackNotifications(pages);

    console.log('Notification process completed');
    return res.status(200).json({
      message: `${pages.length}件の通知を送信しました`,
      count: pages.length,
      results
    });

  } catch (error) {
    console.error('Error in notification process:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});
