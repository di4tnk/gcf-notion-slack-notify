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

async function getNotionPages() {
  try {
    const notion = await initializeNotionClient();

    let databaseId = process.env.NOTION_DATABASE_ID;
    if (!databaseId) {
      try {
        databaseId = await getSecret('NOTION_DATABASE_ID');
      } catch (secretError) {
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
      console.warn(`プロパティ "${lastNotifiedPropertyName}" が見つかりません。重複送信ガードが無効になります。Notionデータベースにdate型で追加してください。`);
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

    const pages = response.results.map(page => {
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

      return { id: page.id, title, url: page.url, lastEditedTime: page.last_edited_time };
    });

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
    properties: {
      [propertyName]: { date: { start: new Date().toISOString() } }
    }
  });
  console.log(`Updated "${propertyName}" for page ${pageId}`);
}

// 既読ボタン押下時に既読者・既読数をNotionに反映する
async function markPageAsRead(pageId, slackUserName) {
  const notion = await initializeNotionClient();
  const page = await notion.pages.retrieve({ page_id: pageId });

  const updates = {};
  const readersPropertyName = process.env.NOTION_READERS_PROPERTY || '既読者';
  const readerCountPropertyName = process.env.NOTION_READER_COUNT_PROPERTY || '既読数';

  if (page.properties[readersPropertyName]) {
    const prop = page.properties[readersPropertyName];
    if (prop.type === 'rich_text') {
      const currentReaders = prop.rich_text.length > 0
        ? prop.rich_text.map(t => t.plain_text).join('')
        : '';
      const newReaders = currentReaders ? `${currentReaders}, ${slackUserName}` : slackUserName;
      updates[readersPropertyName] = { rich_text: [{ text: { content: newReaders } }] };
    } else {
      // people型など rich_text 以外は名前での更新不可のためスキップ
      // Notionの「既読者」プロパティをテキスト型に変更するか、別途手動で管理してください
      console.warn(`Property "${readersPropertyName}" is type "${prop.type}" (not rich_text) — skipping. Change it to text type in Notion to enable auto-update.`);
    }
  } else {
    console.warn(`Property "${readersPropertyName}" not found — skipping 既読者 update`);
  }

  if (page.properties[readerCountPropertyName]) {
    const prop = page.properties[readerCountPropertyName];
    const currentCount = prop.type === 'number' && prop.number !== null ? prop.number : 0;
    updates[readerCountPropertyName] = { number: currentCount + 1 };
  } else {
    console.warn(`Property "${readerCountPropertyName}" not found — skipping 既読数 update`);
  }

  // 既読者と既読数を別々に更新し、片方の失敗が片方に影響しないようにする
  const readersUpdate = updates[readersPropertyName]
    ? { [readersPropertyName]: updates[readersPropertyName] } : null;
  const countUpdate = updates[readerCountPropertyName]
    ? { [readerCountPropertyName]: updates[readerCountPropertyName] } : null;

  if (readersUpdate) {
    await notion.pages.update({ page_id: pageId, properties: readersUpdate });
    console.log(`Updated "${readersPropertyName}" for page ${pageId}`);
  }
  if (countUpdate) {
    await notion.pages.update({ page_id: pageId, properties: countUpdate });
    console.log(`Updated "${readerCountPropertyName}" for page ${pageId}`);
  }
  if (!readersUpdate && !countUpdate) {
    console.warn(`No updatable read properties found for page ${pageId}`);
  } else {
    console.log(`Marked page ${pageId} as read by ${slackUserName}`);
  }
}

module.exports = { getNotionPages, updateLastNotifiedAt, markPageAsRead };
