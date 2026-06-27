const { Client } = require('@notionhq/client');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

let notionClient = null;
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

async function initializeNotionClient() {
  if (!notionClient) {
    const notionToken = process.env.NOTION_TOKEN || await getSecret('NOTION_TOKEN');
    notionClient = new Client({ auth: notionToken });
  }
  return notionClient;
}

// ページ本体のブロックからテキストを抽出して返す（最大 maxLength 文字）
async function getPageBodyExcerpt(pageId, maxLength = 200) {
  try {
    const notion = await initializeNotionClient();
    const response = await notion.blocks.children.list({ block_id: pageId, page_size: 15 });

    const parts = [];
    for (const block of response.results) {
      // paragraph / heading_1-3 / bulleted_list_item / numbered_list_item / quote / callout
      // は全て block[block.type].rich_text を持つ
      const richText = block[block.type]?.rich_text;
      if (richText && richText.length > 0) {
        const text = richText.map(t => t.plain_text).join('').trim();
        if (text) parts.push(text);
      }
      if (parts.join('\n').length >= maxLength) break;
    }

    const full = parts.join('\n');
    if (full.length <= maxLength) return full;
    return full.substring(0, maxLength).trimEnd() + '…';
  } catch (err) {
    console.warn(`Failed to get body excerpt for ${pageId}:`, err.message);
    return '';
  }
}

async function getNotionPages() {
  try {
    const notion = await initializeNotionClient();

    let databaseId = process.env.NOTION_DATABASE_ID;
    if (!databaseId) {
      try {
        databaseId = await getSecret('NOTION_DATABASE_ID');
      } catch {
        throw new Error('NOTION_DATABASE_ID not found in environment variables or Secret Manager');
      }
    }

    const databaseInfo = await notion.databases.retrieve({ database_id: databaseId });
    console.log('Database properties:', Object.keys(databaseInfo.properties));

    // 「通知する」チェックボックスプロパティを特定
    const notifyPropertyName = process.env.NOTION_NOTIFY_PROPERTY || '通知する';
    if (!databaseInfo.properties[notifyPropertyName]) {
      throw new Error(`チェックボックスプロパティ "${notifyPropertyName}" が見つかりません`);
    }

    // 「最終通知日時」の存在確認
    const lastNotifiedPropertyName = process.env.NOTION_LAST_NOTIFIED_PROPERTY || '最終通知日時';
    const hasLastNotifiedProp = !!databaseInfo.properties[lastNotifiedPropertyName];
    if (!hasLastNotifiedProp) {
      console.warn(`"${lastNotifiedPropertyName}" が見つかりません。重複送信ガードが無効になります。`);
    }

    // 「通知する=ON かつ 最終通知日時が空（未通知）」を抽出
    const filter = hasLastNotifiedProp
      ? {
          and: [
            { property: notifyPropertyName, checkbox: { equals: true } },
            { property: lastNotifiedPropertyName, date: { is_empty: true } }
          ]
        }
      : { property: notifyPropertyName, checkbox: { equals: true } };

    const response = await notion.databases.query({ database_id: databaseId, filter });
    console.log(`Found ${response.results.length} pages to notify`);

    // 各ページの本文を並列取得（API呼び出しを最小化）
    const pages = await Promise.all(response.results.map(async page => {
      // タイトル抽出
      const noticeProperty = page.properties['お知らせ'];
      let title = 'Untitled';

      if (noticeProperty) {
        if (noticeProperty.type === 'title' && noticeProperty.title.length > 0) {
          title = noticeProperty.title.map(t => t.plain_text).join('');
        } else if (noticeProperty.type === 'rich_text' && noticeProperty.rich_text.length > 0) {
          title = noticeProperty.rich_text.map(t => t.plain_text).join('');
        }
      }
      if (title === 'Untitled') {
        const fallback = page.properties['Name'] || page.properties['Title'] || page.properties['タイトル'];
        if (fallback && fallback.type === 'title' && fallback.title.length > 0) {
          title = fallback.title.map(t => t.plain_text).join('');
        }
      }

      // 種別（select）
      const kindProp = page.properties['種別'];
      const kind = kindProp?.type === 'select' && kindProp.select ? kindProp.select.name : null;

      // 重要度（select）
      const importanceProp = page.properties['重要度'];
      const importance = importanceProp?.type === 'select' && importanceProp.select
        ? importanceProp.select.name : null;

      // ページ本文の要点を取得
      const body = await getPageBodyExcerpt(page.id);

      return { id: page.id, title, url: page.url, lastEditedTime: page.last_edited_time, body, kind, importance };
    }));

    return pages;

  } catch (error) {
    console.error('Error fetching Notion pages:', error);
    throw new Error(`Failed to fetch Notion pages: ${error.message}`);
  }
}

// Slack通知送信後に最終通知日時を現在時刻で更新し、重複送信を防ぐ
async function updateLastNotifiedAt(pageId) {
  const notion = await initializeNotionClient();
  const propertyName = process.env.NOTION_LAST_NOTIFIED_PROPERTY || '最終通知日時';
  await notion.pages.update({
    page_id: pageId,
    properties: { [propertyName]: { date: { start: new Date().toISOString() } } }
  });
  console.log(`Updated "${propertyName}" for page ${pageId}`);
}

// 既読ボタン押下時に既読者・既読数をNotionに反映し、新しい値を返す
async function markPageAsRead(pageId, slackUserName) {
  const notion = await initializeNotionClient();
  const page = await notion.pages.retrieve({ page_id: pageId });

  const readersPropertyName = process.env.NOTION_READERS_PROPERTY || '既読者';
  const readerCountPropertyName = process.env.NOTION_READER_COUNT_PROPERTY || '既読数';

  let newReaders = '';
  let newCount = 0;

  // ── 既読者 (rich_text) ─────────────────────────────
  const readersProp = page.properties[readersPropertyName];
  if (readersProp) {
    if (readersProp.type === 'rich_text') {
      const current = readersProp.rich_text.length > 0
        ? readersProp.rich_text.map(t => t.plain_text).join('')
        : '';

      // 重複チェック（カンマ区切りで名前が既に含まれていればスキップ）
      const names = current.split(',').map(s => s.trim()).filter(Boolean);
      if (names.includes(slackUserName)) {
        console.log(`${slackUserName} already in 既読者 — skipping duplicate`);
        newReaders = current;
      } else {
        newReaders = current ? `${current}, ${slackUserName}` : slackUserName;
        try {
          await notion.pages.update({
            page_id: pageId,
            properties: { [readersPropertyName]: { rich_text: [{ text: { content: newReaders } }] } }
          });
          console.log(`Updated "${readersPropertyName}" for page ${pageId}`);
        } catch (err) {
          console.warn(`Failed to update "${readersPropertyName}":`, err.message);
          newReaders = current;
        }
      }
    } else {
      console.warn(`"${readersPropertyName}" is type "${readersProp.type}" (not rich_text) — skipping`);
    }
  } else {
    console.warn(`"${readersPropertyName}" not found — skipping 既読者 update`);
  }

  // ── 既読数 (number) ────────────────────────────────
  const countProp = page.properties[readerCountPropertyName];
  if (countProp) {
    if (countProp.type === 'number') {
      const current = countProp.number !== null ? countProp.number : 0;
      newCount = current + 1;
      try {
        await notion.pages.update({
          page_id: pageId,
          properties: { [readerCountPropertyName]: { number: newCount } }
        });
        console.log(`Updated "${readerCountPropertyName}" to ${newCount} for page ${pageId}`);
      } catch (err) {
        console.warn(`Failed to update "${readerCountPropertyName}":`, err.message);
        newCount = current;
      }
    } else {
      console.warn(`"${readerCountPropertyName}" is type "${countProp.type}" (not number) — skipping`);
    }
  } else {
    console.warn(`"${readerCountPropertyName}" not found — skipping 既読数 update`);
  }

  console.log(`Marked page ${pageId} as read by ${slackUserName}`);
  return { readerCount: newCount, readers: newReaders };
}

module.exports = { getNotionPages, updateLastNotifiedAt, markPageAsRead };
