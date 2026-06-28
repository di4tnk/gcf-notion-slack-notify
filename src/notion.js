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

// Notionのボタン「Webhookを送信する」ペイロードからページIDを抽出する。
// 複数の候補パスを順に探し、最初に見つかったUUID形式の値を返す。
// 見つからない場合は null を返す。
function extractPageIdFromWebhookPayload(body) {
  if (!body || typeof body !== 'object') return null;

  function isValidId(v) {
    return typeof v === 'string' &&
      /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(v);
  }

  function normalizeId(id) {
    const h = id.replace(/-/g, '');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  function extractFromUrl(url) {
    if (typeof url !== 'string') return null;
    // UUID形式
    const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (m) return m[0];
    // ハイフンなし32文字（Notionページ URL末尾）
    const m2 = url.match(/([0-9a-f]{32})(?:[?#]|$)/i);
    if (m2) return normalizeId(m2[1]);
    return null;
  }

  // 直接IDフィールドを探す（候補パスを順に試す）
  const idCandidates = [
    body?.data?.id,
    body?.id,
    body?.page?.id,
    body?.data?.page?.id,
  ];
  for (const c of idCandidates) {
    if (isValidId(c)) {
      const id = normalizeId(c);
      console.log(`extractPageIdFromWebhookPayload: found id "${id}"`);
      return id;
    }
  }

  // URLフィールドからIDを抽出
  const urls = [
    body?.data?.url,
    body?.url,
    body?.data?.public_url,
    body?.public_url,
  ];
  for (const url of urls) {
    const id = extractFromUrl(url);
    if (id) {
      console.log(`extractPageIdFromWebhookPayload: extracted id "${id}" from url`);
      return id;
    }
  }

  console.log('extractPageIdFromWebhookPayload: no page ID found in payload');
  return null;
}

// ページブロックからテキストを抽出して返す（最大 maxLength 文字）
async function getPageBodyExcerpt(pageId, maxLength = 200) {
  try {
    const notion = await initializeNotionClient();
    const response = await notion.blocks.children.list({ block_id: pageId, page_size: 15 });

    const parts = [];
    for (const block of response.results) {
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

// Notionページオブジェクト → 通知用データ変換（内部ヘルパー）
async function pageToData(page) {
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
    if (fallback?.type === 'title' && fallback.title.length > 0) {
      title = fallback.title.map(t => t.plain_text).join('');
    }
  }

  const kindProp = page.properties['種別'];
  const kind = kindProp?.type === 'select' && kindProp.select ? kindProp.select.name : null;

  const importanceProp = page.properties['重要度'];
  const importance = importanceProp?.type === 'select' && importanceProp.select
    ? importanceProp.select.name : null;

  const body = await getPageBodyExcerpt(page.id);

  return { id: page.id, title, url: page.url, lastEditedTime: page.last_edited_time, body, kind, importance };
}

// ページIDを指定して1ページ取得し、未通知ならデータを返す。通知済みなら null を返す。
async function getPageById(pageId) {
  try {
    const notion = await initializeNotionClient();
    const page = await notion.pages.retrieve({ page_id: pageId });

    const lastNotifiedPropertyName = process.env.NOTION_LAST_NOTIFIED_PROPERTY || '最終通知日時';
    const lastNotifiedProp = page.properties[lastNotifiedPropertyName];

    if (lastNotifiedProp?.date?.start) {
      console.log(`Page ${pageId} already notified at ${lastNotifiedProp.date.start} — skipping`);
      return null;
    }

    console.log(`Page ${pageId} is unnotified — preparing notification`);
    return await pageToData(page);
  } catch (err) {
    console.error(`Failed to retrieve page ${pageId}:`, err.message);
    return null;
  }
}

// フォールバック: 最終通知日時が空のページをDBクエリで取得する。
// 「通知する」チェックボックスは条件に使わない。
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

    const lastNotifiedPropertyName = process.env.NOTION_LAST_NOTIFIED_PROPERTY || '最終通知日時';

    const response = await notion.databases.query({
      database_id: databaseId,
      filter: { property: lastNotifiedPropertyName, date: { is_empty: true } }
    });
    console.log(`Found ${response.results.length} unnotified pages (fallback query)`);

    const pages = await Promise.all(response.results.map(pageToData));
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

// 確認ボタン押下時に確認者・確認数・確認者IDをNotionに反映し、新しい値を返す
async function markPageAsConfirmed(pageId, slackUserName, slackUserId) {
  const notion = await initializeNotionClient();
  const page = await notion.pages.retrieve({ page_id: pageId });

  const readersPropertyName = process.env.NOTION_READERS_PROPERTY || '確認者';
  const readerCountPropertyName = process.env.NOTION_READER_COUNT_PROPERTY || '確認数';
  const confirmedIdsPropertyName = process.env.NOTION_CONFIRMED_IDS_PROPERTY || '確認者ID';

  let newReaders = '';
  let newCount = 0;

  // ── 確認者 (rich_text) ────────────────────────────
  const readersProp = page.properties[readersPropertyName];
  if (readersProp) {
    if (readersProp.type === 'rich_text') {
      const current = readersProp.rich_text.length > 0
        ? readersProp.rich_text.map(t => t.plain_text).join('')
        : '';

      const names = current.split(',').map(s => s.trim()).filter(Boolean);
      if (names.includes(slackUserName)) {
        console.log(`${slackUserName} already in 確認者 — skipping duplicate`);
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
    console.warn(`"${readersPropertyName}" not found — skipping 確認者 update`);
  }

  // ── 確認数 (number) ───────────────────────────────
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
    console.warn(`"${readerCountPropertyName}" not found — skipping 確認数 update`);
  }

  // ── 確認者ID (rich_text) — カンマ区切りで蓄積 ────
  if (slackUserId) {
    const confirmedIdsProp = page.properties[confirmedIdsPropertyName];
    if (confirmedIdsProp?.type === 'rich_text') {
      const current = confirmedIdsProp.rich_text.length > 0
        ? confirmedIdsProp.rich_text.map(t => t.plain_text).join('')
        : '';
      const ids = current.split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.includes(slackUserId)) {
        const newIds = ids.length > 0 ? `${current},${slackUserId}` : slackUserId;
        try {
          await notion.pages.update({
            page_id: pageId,
            properties: { [confirmedIdsPropertyName]: { rich_text: [{ text: { content: newIds } }] } }
          });
          console.log(`Updated "${confirmedIdsPropertyName}" for page ${pageId}`);
        } catch (err) {
          console.warn(`Failed to update "${confirmedIdsPropertyName}":`, err.message);
        }
      } else {
        console.log(`${slackUserId} already in 確認者ID — skipping duplicate`);
      }
    } else {
      console.warn(`"${confirmedIdsPropertyName}" not found or not rich_text — skipping 確認者ID update`);
    }
  }

  console.log(`Marked page ${pageId} as confirmed by ${slackUserName} (${slackUserId})`);
  return { readerCount: newCount, readers: newReaders };
}

// 本日（Asia/Tokyo）が締切のお知らせを取得する（リマインダー用）
// 各ページに confirmedIds（確認者IDの配列）を付与して返す
async function getAnnouncementsWithDeadlineToday() {
  const notion = await initializeNotionClient();
  let databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) {
    try {
      databaseId = await getSecret('NOTION_DATABASE_ID');
    } catch {
      throw new Error('NOTION_DATABASE_ID not found in environment variables or Secret Manager');
    }
  }

  // Asia/Tokyo (UTC+9) での今日の日付
  const todayJST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const deadlinePropertyName = process.env.NOTION_DEADLINE_PROPERTY || '締切';
  const confirmedIdsPropertyName = process.env.NOTION_CONFIRMED_IDS_PROPERTY || '確認者ID';

  const response = await notion.databases.query({
    database_id: databaseId,
    filter: { property: deadlinePropertyName, date: { equals: todayJST } }
  });
  console.log(`Found ${response.results.length} pages with deadline today (${todayJST})`);

  return await Promise.all(response.results.map(async (page) => {
    const data = await pageToData(page);
    const confirmedIdsProp = page.properties[confirmedIdsPropertyName];
    const confirmedIdsStr = confirmedIdsProp?.type === 'rich_text' && confirmedIdsProp.rich_text.length > 0
      ? confirmedIdsProp.rich_text.map(t => t.plain_text).join('')
      : '';
    const confirmedIds = confirmedIdsStr.split(',').map(s => s.trim()).filter(Boolean);
    return { ...data, confirmedIds };
  }));
}

module.exports = {
  extractPageIdFromWebhookPayload,
  getPageById,
  getNotionPages,
  updateLastNotifiedAt,
  markPageAsConfirmed,
  getAnnouncementsWithDeadlineToday
};
