/**
 * Google Photos 非公式Web API クライアント
 * 
 * Google-Photos-Toolkit のアプローチを参考に、
 * batchexecute エンドポイントを使用して写真データを取得
 * 
 * 注意: この API は非公式であり、Google の仕様変更により動作しなくなる可能性があります
 */

import { addDebugLog } from './googleAuthService';

// RPC ID 定義
const RPC_IDS = {
  GET_ALBUMS: 'Z5xsfc',           // アルバム一覧取得
  GET_ALBUM_PAGE: 'snAcKc',       // アルバム内の写真取得
  GET_ITEMS_BY_DATE: 'lcxiM',     // タイムライン（日付順）取得
  GET_ITEMS_BY_UPLOAD: 'EzkLib',  // アップロード順で取得
  GET_SHARED_LINKS: 'F2A0H',      // 共有リンク一覧
  TRASH_OPERATIONS: 'XwAOJf',     // 削除・復元操作（Gemini確認済み）
  DELETE_ALBUM: 'nV6Qv',          // アルバム削除（実機Network検証済み 2026-02-25）
  CREATE_PUBLIC_SHARE: 'yI1ii',    // 公開共有リンク作成（PC Network検証 2026-04-01 リンクを作成ボタン）
  GET_TRASH_ITEMS: 'zy0lHe',      // ゴミ箱一覧取得（PC検証 2026-03-22、空配列でリクエスト）
  GET_PHOTO_DETAIL: 'VrseUb',     // 写真詳細取得（PC検証 2026-03-23、dedupKeyがレスポンス[3]に含まれる）
  ADD_PHOTOS_TO_ALBUM: 'laUYf',   // アルバムに写真追加（PC Network検証済み 2026-04-21）
};

/**
 * セッション情報を保持するクラス
 */
class SessionManager {
  constructor() {
    this.at = null;          // XSRF トークン
    this.sid = null;         // セッション ID (f.sid)
    this.bl = null;          // バックエンドバージョン
    this.cookies = null;     // Cookie 文字列
    this.isValid = false;
  }

  /**
   * WIZ_global_data から抽出した値でセッションを設定
   */
  setFromWizData(wizData, cookies = null) {
    this.at = wizData.SNlM0e;
    this.sid = wizData.FdrFJe;
    this.bl = wizData.cfb2h;
    this.cookies = cookies;
    this.isValid = !!(this.at && this.sid && this.bl);
    return this.isValid;
  }

  /**
   * セッションをクリア
   */
  clear() {
    this.at = null;
    this.sid = null;
    this.bl = null;
    this.cookies = null;
    this.isValid = false;
  }
}

// グローバルセッションマネージャー
export const sessionManager = new SessionManager();

/**
 * batchexecute API にリクエストを送信
 * 
 * @param {string} rpcid - RPC ID
 * @param {any} requestData - リクエストデータ
 * @param {object} options - オプション（retry等）
 * @returns {Promise<any>} パースされたレスポンス
 */
export async function makeApiRequest(rpcid, requestData, options = {}) {
  const { maxRetries = 3, retryDelay = 2000, sourcePath = '/u/0/photos', useUserPath = false, extraParams = {}, skipPageId = false } = options;

  if (!sessionManager.isValid) {
    throw new Error('セッションが無効です。再度ログインしてください。');
  }

  const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
  const requestBody = `f.req=${encodeURIComponent(JSON.stringify(wrappedData))}&at=${encodeURIComponent(sessionManager.at)}&`;

  const paramsObj = {
    rpcids: rpcid,
    'source-path': sourcePath,
    'f.sid': sessionManager.sid,
    bl: sessionManager.bl,
    rt: 'c',
    ...extraParams,
  };
  if (!skipPageId) paramsObj.pageId = 'none';
  const params = new URLSearchParams(paramsObj);

  const baseUrl = useUserPath
    ? 'https://photos.google.com/u/0/_/PhotosUi/data/batchexecute'
    : 'https://photos.google.com/_/PhotosUi/data/batchexecute';
  const url = `${baseUrl}?${params.toString()}`;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      };

      // /u/0/ エンドポイント使用時は追加ヘッダーが必要
      if (useUserPath) {
        headers['x-same-domain'] = '1';
        headers['x-goog-ext-353267353-jspb'] = '[null,null,null,128907]';
      }

      // Cookie があれば追加
      if (sessionManager.cookies) {
        headers['Cookie'] = sessionManager.cookies;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: requestBody,
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const responseBody = await response.text();

      if (!responseBody) {
        throw new Error('空のレスポンス');
      }

      // wrb.fr エンベロープを探す
      const jsonLines = responseBody.split('\n').filter(line => line.includes('wrb.fr'));

      if (jsonLines.length === 0) {
        throw new Error('wrb.fr エンベロープが見つかりません');
      }

      const parsedData = JSON.parse(jsonLines[0]);

      if (!parsedData?.[0]?.[2]) {
        if (options.logEmptyPayload) {
          addDebugLog('API_RAW', `${rpcid} empty payload`, {
            row0: JSON.stringify(parsedData?.[0])?.slice(0, 500),
          });
        }
        throw new Error('レスポンスにペイロードがありません');
      }

      return JSON.parse(parsedData[0][2]);
    } catch (error) {
      lastError = error;
      console.error(`[${rpcid}] リクエストエラー (${attempt}/${maxRetries}):`, error.message);

      if (attempt < maxRetries) {
        await sleep(retryDelay * attempt);
      }
    }
  }

  throw lastError || new Error(`${rpcid} リクエストが ${maxRetries} 回失敗しました`);
}

/**
 * ゴミ箱用 batchexecute API にリクエストを送信
 * source-path を /trash に設定
 * 
 * @param {string} rpcid - RPC ID
 * @param {any} requestData - リクエストデータ
 * @param {object} options - オプション（retry等）
 * @returns {Promise<any>} パースされたレスポンス
 */
async function makeApiRequestForTrash(rpcid, requestData, options = {}, sourceMediaKey = null) {
  const { maxRetries = 3, retryDelay = 2000 } = options;

  if (!sessionManager.isValid) {
    throw new Error('セッションが無効です。再度ログインしてください。');
  }

  // PC検証結果: f.req=[[["zy0lHe","[]",null,"1"]]]
  const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
  const requestBody = `f.req=${encodeURIComponent(JSON.stringify(wrappedData))}&at=${encodeURIComponent(sessionManager.at)}&`;

  // PC検証: source-pathは /trash/{mediaKey} 形式（mediaKeyがある場合）
  const sourcePath = sourceMediaKey ? `/trash/${sourceMediaKey}` : '/trash';
  const params = new URLSearchParams({
    rpcids: rpcid,
    'source-path': sourcePath,
    'f.sid': sessionManager.sid,
    bl: sessionManager.bl,
    rt: 'c',
  });

  const url = `https://photos.google.com/_/PhotosUi/data/batchexecute?${params.toString()}`;
  console.log('[TRASH API] Request URL:', url);
  console.log('[TRASH API] Request body preview:', requestBody.substring(0, 200));

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      };
      
      // Cookie があれば追加
      if (sessionManager.cookies) {
        headers['Cookie'] = sessionManager.cookies;
      }

      console.log('[TRASH API] Attempt', attempt, '/', maxRetries);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: requestBody,
        credentials: 'include',
      });

      console.log('[TRASH API] Response status:', response.status);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const responseBody = await response.text();
      console.log('[TRASH API] Response length:', responseBody.length);
      console.log('[TRASH API] Response preview:', responseBody.substring(0, 500));

      if (!responseBody) {
        throw new Error('空のレスポンス');
      }

      // wrb.fr エンベロープを探す
      const jsonLines = responseBody.split('\n').filter(line => line.includes('wrb.fr'));
      console.log('[TRASH API] Found wrb.fr lines:', jsonLines.length);

      if (jsonLines.length === 0) {
        throw new Error('wrb.fr エンベロープが見つかりません');
      }

      const parsedData = JSON.parse(jsonLines[0]);
      console.log('[TRASH API] Parsed data[0][2] preview:', parsedData?.[0]?.[2]?.substring?.(0, 300) || 'N/A');

      if (!parsedData?.[0]?.[2]) {
        throw new Error('レスポンスにペイロードがありません');
      }

      return JSON.parse(parsedData[0][2]);
    } catch (error) {
      lastError = error;
      console.error(`[${rpcid}] リクエストエラー (${attempt}/${maxRetries}):`, error.message);

      if (attempt < maxRetries) {
        await sleep(retryDelay * attempt);
      }
    }
  }

  throw lastError || new Error(`${rpcid} リクエストが ${maxRetries} 回失敗しました`);
}

/**
 * アルバム一覧を取得
 * 
 * @param {string|null} pageId - ページネーショントークン
 * @param {number} pageSize - 取得件数
 * @returns {Promise<AlbumsPage>}
 */
export async function getAlbums(pageId = null, pageSize = 100) {
  const requestData = [pageId, null, null, null, 1, null, null, pageSize, [2], 5];
  const response = await makeApiRequest(RPC_IDS.GET_ALBUMS, requestData);
  return parseAlbumsPage(response);
}

/**
 * アルバム内の写真を取得
 * 
 * @param {string} albumMediaKey - アルバムのメディアキー
 * @param {string|null} pageId - ページネーショントークン
 * @param {string|null} authKey - 共有アルバム用の認証キー
 * @returns {Promise<AlbumItemsPage>}
 */
export async function getAlbumPage(albumMediaKey, pageId = null, authKey = null) {
  const requestData = [albumMediaKey, pageId, null, authKey];
  const response = await makeApiRequest(RPC_IDS.GET_ALBUM_PAGE, requestData);
  return parseAlbumItemsPage(response);
}

/**
 * アルバムの全写真を取得（自動ページネーション）
 * 
 * @param {string} albumMediaKey - アルバムのメディアキー
 * @param {string|null} authKey - 共有アルバム用の認証キー
 * @param {function} onProgress - 進捗コールバック (loadedCount, totalCount) => void
 * @returns {Promise<MediaItem[]>}
 */
export async function getAllAlbumItems(albumMediaKey, authKey = null, onProgress = null) {
  const allItems = [];
  let pageId = null;
  let totalCount = 0;

  do {
    const page = await getAlbumPage(albumMediaKey, pageId, authKey);
    
    if (page.items) {
      allItems.push(...page.items);
    }
    
    if (totalCount === 0 && page.itemCount) {
      totalCount = page.itemCount;
    }
    
    if (onProgress) {
      onProgress(allItems.length, totalCount);
    }
    
    pageId = page.nextPageId;
    
    // レートリミット対策
    if (pageId) {
      await sleep(300);
    }
  } while (pageId);

  return allItems;
}

/**
 * 写真をタイムライン（撮影日）順で取得
 * 
 * @param {number|null} timestamp - この日時より前の写真を取得（ミリ秒）
 * @param {string|null} source - 'library', 'archive', または null（両方）
 * @param {string|null} pageId - ページネーショントークン
 * @param {number} pageSize - 取得件数
 * @returns {Promise<TimelinePage>}
 */
export async function getItemsByTakenDate(timestamp = null, source = null, pageId = null, pageSize = 500) {
  let sourceCode;
  if (source === 'library') sourceCode = 1;
  else if (source === 'archive') sourceCode = 2;
  else sourceCode = 3; // both

  const requestData = [pageId, timestamp, pageSize, null, 1, sourceCode];
  const response = await makeApiRequest(RPC_IDS.GET_ITEMS_BY_DATE, requestData);
  return parseTimelinePage(response);
}

/**
 * 共有リンク一覧を取得
 * 
 * @param {string|null} pageId - ページネーショントークン
 * @returns {Promise<LinksPage>}
 */
export async function getSharedLinks(pageId = null) {
  const requestData = [pageId, null, 2, null, 3];
  const response = await makeApiRequest(RPC_IDS.GET_SHARED_LINKS, requestData);
  return parseLinksPage(response);
}

// ============================================
// パーサー関数
// ============================================

/**
 * メディアアイテムをパース
 */
function parseMediaItem(itemData) {
  if (!itemData) return null;

  return {
    mediaKey: itemData?.[0],
    thumb: itemData?.[1]?.[0],
    resWidth: itemData?.[1]?.[1],
    resHeight: itemData?.[1]?.[2],
    timestamp: itemData?.[2],
    dedupKey: itemData?.[3],
    timezoneOffset: itemData?.[4],
    creationTimestamp: itemData?.[5],
    isLivePhoto: itemData?.at?.(-1)?.[146008172] ? true : false,
    livePhotoDuration: itemData?.at?.(-1)?.[146008172]?.[1],
    duration: itemData?.at?.(-1)?.[76647426]?.[0],
    descriptionShort: itemData?.at?.(-1)?.[396644657]?.[0],
    isArchived: itemData?.[13],
    isFavorite: itemData?.at?.(-1)?.[163238866]?.[0],
    geoLocation: {
      coordinates: itemData?.at?.(-1)?.[129168200]?.[1]?.[0],
      name: itemData?.at?.(-1)?.[129168200]?.[1]?.[4]?.[0]?.[1]?.[0]?.[0],
    },
    // Gemini推奨：API IDフィールド追加（後から紐付け用）
    apiMediaItemId: null,
  };
}

/**
 * アルバムをパース
 */
function parseAlbum(itemData) {
  if (!itemData) return null;
  
  const extData = itemData?.at?.(-1)?.[72930366];
  
  return {
    mediaKey: itemData?.[0],
    ownerActorId: itemData?.[6]?.[0],
    title: extData?.[1],
    thumb: itemData?.[1]?.[0],
    itemCount: extData?.[3],
    creationTimestamp: extData?.[2]?.[4],
    modifiedTimestamp: extData?.[2]?.[9],
    timestampRange: [extData?.[2]?.[5], extData?.[2]?.[6]],
    isShared: extData?.[4] || false,
  };
}

/**
 * アルバム一覧ページをパース
 */
function parseAlbumsPage(data) {
  return {
    items: data?.[0]?.map(item => parseAlbum(item)).filter(Boolean) || [],
    nextPageId: data?.[1] || null,
  };
}

/**
 * アルバム内アイテムページをパース
 */
function parseAlbumItemsPage(data) {
  const albumInfo = data?.[3];
  const owner = albumInfo?.[5];
  
  return {
    items: data?.[1]?.map(item => parseMediaItem(item)).filter(Boolean) || [],
    nextPageId: data?.[2] || null,
    mediaKey: albumInfo?.[0],
    title: albumInfo?.[1],
    owner: owner ? {
      actorId: owner?.[0],
      gaiaId: owner?.[1],
      name: owner?.[11]?.[0],
      profilePhotoUrl: owner?.[12]?.[0],
    } : null,
    itemCount: albumInfo?.[21],
    authKey: albumInfo?.[19],
    startTimestamp: albumInfo?.[2]?.[5],
    endTimestamp: albumInfo?.[2]?.[6],
    creationTimestamp: albumInfo?.[2]?.[8],
  };
}

/**
 * タイムラインページをパース
 */
function parseTimelinePage(data) {
  return {
    items: data?.[0]?.map(item => parseMediaItem(item)).filter(Boolean) || [],
    nextPageId: data?.[1] || null,
    lastItemTimestamp: parseInt(data?.[2]) || null,
  };
}

/**
 * 共有リンクをパース
 */
function parseSharedLink(itemData) {
  return {
    mediaKey: itemData?.[6],
    linkId: itemData?.[17],
    itemCount: itemData?.[3],
  };
}

/**
 * 共有リンク一覧ページをパース
 */
function parseLinksPage(data) {
  return {
    items: data?.[0]?.map(item => parseSharedLink(item)).filter(Boolean) || [],
    nextPageId: data?.[1] || null,
  };
}

// ============================================
// ユーティリティ関数
// ============================================

/**
 * サムネイルURLを生成
 * 
 * @param {string} baseThumb - ベースサムネイルURL
 * @param {number} width - 幅
 * @param {number} height - 高さ
 * @param {boolean} crop - クロップするか
 * @returns {string}
 */
export function getPhotoUrl(baseThumb, width = 400, height = 400, crop = true) {
  if (!baseThumb) return null;
  
  // 既存のパラメータを除去
  const baseUrl = baseThumb.split('=')[0];
  const params = crop ? `=w${width}-h${height}-c` : `=w${width}-h${height}`;
  return `${baseUrl}${params}`;
}

/**
 * フルサイズ画像URLを生成
 * 
 * @param {string} baseThumb - ベースサムネイルURL
 * @param {number} maxWidth - 最大幅
 * @param {number} maxHeight - 最大高さ
 * @returns {string}
 */
export function getFullSizeUrl(baseThumb, maxWidth = 4096, maxHeight = 4096) {
  if (!baseThumb) return null;
  
  // ローカルURI（file://やcontent://）はそのまま返す（楽観的更新で追加された写真）
  if (baseThumb.startsWith('file://') || baseThumb.startsWith('content://') || baseThumb.startsWith('ph://')) {
    return baseThumb;
  }
  
  const baseUrl = baseThumb.split('=')[0];
  
  // maxWidth=0, maxHeight=0の場合はオリジナルサイズ（=d）を返す
  if (maxWidth === 0 && maxHeight === 0) {
    return `${baseUrl}=d`;
  }
  
  return `${baseUrl}=w${maxWidth}-h${maxHeight}`;
}

/**
 * 動画URLを生成
 * 
 * @param {string} baseThumb - ベースサムネイルURL
 * @returns {string}
 */
export function getVideoUrl(baseThumb) {
  if (!baseThumb) return null;
  
  // ローカルURI（file://やcontent://）はそのまま返す（楽観的更新で追加された動画）
  if (baseThumb.startsWith('file://') || baseThumb.startsWith('content://') || baseThumb.startsWith('ph://')) {
    return baseThumb;
  }
  
  const baseUrl = baseThumb.split('=')[0];
  return `${baseUrl}=dv`;
}

/**
 * メディアアイテムが動画かどうか判定
 */
export function isVideoItem(item) {
  return item?.duration != null && item.duration > 0;
}

/**
 * タイムスタンプをDateオブジェクトに変換
 */
export function timestampToDate(timestamp) {
  if (!timestamp) return null;
  return new Date(parseInt(timestamp));
}

/**
 * 指定ミリ秒待機
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// 削除・復元機能（Gemini確認済み）
// ============================================

/**
 * 写真をゴミ箱に移動（削除）
 *
 * @param {string[]} dedupKeys - 削除する写真のdedupKey配列
 * @returns {Promise<any>} 削除結果
 */
export async function moveItemsToTrash(dedupKeys) {
  if (!Array.isArray(dedupKeys) || dedupKeys.length === 0) {
    throw new Error('dedupKeysは空でない配列である必要があります');
  }

  // Gemini推奨：一度に50件まで
  if (dedupKeys.length > 50) {
    throw new Error('一度に削除できるのは50件までです');
  }

  // リクエスト形式: [null, 1, dedupKeyArray, 3]
  // 1 = 削除操作、3 = 固定値
  const requestData = [null, 1, dedupKeys, 3];

  try {
    const response = await makeApiRequest(RPC_IDS.TRASH_OPERATIONS, requestData);
    return response[0];
  } catch (error) {
    console.error('[DELETE] Error in moveItemsToTrash:', error);
    throw error;
  }
}

/**
 * mediaKeyからdedupKeyを取得（VrseUb RPC）
 * ゴミ箱一覧(eNG3nf)はdedupKeyを返さないため、復元前にこれで取得する
 * PC検証 2026-03-23: レスポンス[3]にdedupKeyが入っている
 *
 * @param {string} mediaKey - AF1Qip...形式のmediaKey
 * @returns {Promise<string|null>} dedupKey
 */
export async function getDedupKeyFromMediaKey(mediaKey) {
  try {
    // PC検証 2026-03-23: requestData=[mediaKey, null, null, 1], source-path=/trash/{mediaKey}
    const requestData = [mediaKey, null, null, 1];
    const response = await makeApiRequestForTrash(RPC_IDS.GET_PHOTO_DETAIL, requestData, {}, mediaKey);
    // response[0]がphotoデータ配列、そのindex[3]がdedupKey
    const dedupKey = response?.[0]?.[3] || null;
    console.log(`[DEDUP] mediaKey=${mediaKey.substring(0, 20)}... dedupKey=${dedupKey}`);
    return dedupKey;
  } catch (error) {
    console.error('[DEDUP] getDedupKeyFromMediaKey failed:', error.message);
    return null;
  }
}

/**
 * 写真をゴミ箱から復元
 *
 * @param {string[]} dedupKeys - 復元する写真のdedupKey配列
 * @returns {Promise<any>} 復元結果
 */
export async function restoreFromTrash(dedupKeys, sourceMediaKey = null) {
  if (!Array.isArray(dedupKeys) || dedupKeys.length === 0) {
    throw new Error('dedupKeysは空でない配列である必要があります');
  }

  if (dedupKeys.length > 50) {
    throw new Error('一度に復元できるのは50件までです');
  }

  // moveItemsToTrashと同じmakeApiRequestを使用（source-path: /u/0/photos）
  const requestData = [null, 3, dedupKeys, 2];

  try {
    const response = await makeApiRequest(RPC_IDS.TRASH_OPERATIONS, requestData, { maxRetries: 1 });
    console.log('[RESTORE] Response:', JSON.stringify(response)?.substring(0, 200));
    return response?.[0] ?? null;
  } catch (error) {
    console.error('[RESTORE] Error:', error.message);
    throw error;
  }
}

/**
 * ゴミ箱から完全に削除
 * PC検証 2026-03-23: [null, 2, dedupKeys, 2], source-path=/trash/{mediaKey}
 *
 * @param {string[]} dedupKeys - 削除する写真のdedupKey配列
 * @param {string|null} sourceMediaKey - source-path用のmediaKey
 * @returns {Promise<any>} 削除結果
 */
export async function permanentlyDeleteFromTrash(dedupKeys, sourceMediaKey = null) {
  if (!Array.isArray(dedupKeys) || dedupKeys.length === 0) {
    throw new Error('dedupKeysは空でない配列である必要があります');
  }

  if (dedupKeys.length > 50) {
    throw new Error('一度に削除できるのは50件までです');
  }

  const requestData = [null, 2, dedupKeys, 2];

  try {
    const response = await makeApiRequest(RPC_IDS.TRASH_OPERATIONS, requestData, { maxRetries: 1 });
    console.log('[PERM_DELETE] Response:', JSON.stringify(response)?.substring(0, 200));
    return response?.[0] ?? null;
  } catch (error) {
    console.error('[PERM_DELETE] Error:', error.message);
    throw error;
  }
}

/**
 * ゴミ箱内のアイテム一覧を取得
 * PC検証 2026-03-22: rpcid=zy0lHe, requestData=[], source-path=/trash
 *
 * @param {string|null} pageToken - ページネーショントークン（未使用、将来のページネーション用）
 * @returns {Promise<Object>} ゴミ箱アイテム一覧
 */
export async function getTrashItems(pageToken = null) {
  // PC検証結果: 空配列でリクエスト
  const requestData = [];

  try {
    console.log('[TRASH] Fetching trash items with RPC:', RPC_IDS.GET_TRASH_ITEMS);
    const response = await makeApiRequestForTrash(RPC_IDS.GET_TRASH_ITEMS, requestData);
    console.log('[TRASH] Raw response:', JSON.stringify(response).substring(0, 500));
    
    // レスポンスをパース
    const items = parseTrashItems(response);
    const nextPageToken = response?.[1] || null;
    
    return {
      items,
      nextPageToken,
      hasMore: !!nextPageToken,
    };
  } catch (error) {
    console.error('[TRASH] Error in getTrashItems:', error);
    throw error;
  }
}

/**
 * ゴミ箱アイテムをパース
 * PC検証 2026-03-22のレスポンス構造:
 * [[["AF1QipMr-...", ["https://...", 1253, 939, ...], 1743229544191, "dedupKey", 32400000, 1774122175448, ...]]]
 * [0]: mediaKey, [1]: [thumb, w, h, ...], [2]: timestamp, [3]: dedupKey, [4]: tzOffset, [5]: createdOrDeleted
 */
function parseTrashItems(response) {
  try {
    // レスポンス構造: [[[item1], [item2], ...]] または [[item1, item2, ...]]
    let itemsData = response;
    
    // ネストされている場合を考慮
    if (Array.isArray(response) && Array.isArray(response[0])) {
      // response[0]が配列の配列かチェック
      if (Array.isArray(response[0][0]) && typeof response[0][0][0] === 'string' && response[0][0][0].startsWith('AF1Qip')) {
        // 構造: [[[item1], [item2], ...]]
        itemsData = response[0];
      } else if (typeof response[0][0] === 'string' && response[0][0].startsWith('AF1Qip')) {
        // 単一アイテム: [[item]]
        itemsData = [response[0]];
      } else {
        itemsData = response[0];
      }
    }
    
    if (!Array.isArray(itemsData)) {
      console.log('[TRASH] itemsData is not an array:', typeof itemsData);
      return [];
    }

    const items = itemsData.map((itemData, index) => {
      if (!itemData) return null;
      
      // 配列がネストされている場合
      const data = Array.isArray(itemData[0]) ? itemData[0] : itemData;
      
      // mediaKeyがAF1Qipで始まるかチェック
      if (typeof data[0] !== 'string' || !data[0].startsWith('AF1Qip')) {
        console.log(`[TRASH] Item ${index} does not have valid mediaKey:`, data[0]);
        return null;
      }
      
      return {
        mediaKey: data[0],
        thumb: data[1]?.[0],
        resWidth: data[1]?.[1],
        resHeight: data[1]?.[2],
        timestamp: data[2],
        dedupKey: data[3],
        timezoneOffset: data[4],
        // [5]は作成時刻または削除時刻
        deletedTimestamp: data[5],
      };
    }).filter(Boolean);

    console.log(`[TRASH] Parsed ${items.length} trash items`);
    return items;
  } catch (error) {
    console.error('[TRASH] Parse error:', error);
    return [];
  }
}

/**
 * アルバムを削除
 * RPC ID: nV6Qv（実機Network検証済み 2026-02-25）
 * リクエスト形式: [null, null, [[apiAlbumId, null, 1]]]
 *
 * @param {string} apiAlbumId - 削除するアルバムのID（AF1Qip...形式）
 * @returns {Promise<any>} 削除結果
 */
export async function deleteAlbum(shortId, mediaKey) {
  if (!shortId && !mediaKey) {
    throw new Error('shortIdまたはmediaKeyが必要です');
  }

  // 実際のWebのペイロード: [[shortId(45文字), mediaKey(73文字), 1]]
  // shortIdが不明な場合はmediaKeyのみで試みる（PC側に反映されない可能性あり）
  const requestData = [null, null, [[shortId || mediaKey, mediaKey || shortId, 1]]];

  try {
    // maxRetries: 1 → DELETEはリトライ不要（成功時はペイロードなしで返る）
    const response = await makeApiRequest(RPC_IDS.DELETE_ALBUM, requestData, { maxRetries: 1, sourcePath: '/albums' });
    return response;
  } catch (error) {
    // DELETEのレスポンスはペイロードなしの場合がある（HTTPリクエスト自体は成功）
    if (error.message.includes('ペイロードがありません') ||
        error.message.includes('wrb.fr エンベロープが見つかりません') ||
        error.message.includes('空のレスポンス')) {
      return null;
    }
    console.error('[DELETE_ALBUM] Error:', error);
    throw error;
  }
}

/**
 * アルバムの公開共有リンクを作成して取得
 *
 * PC Network検証 2026-04-01:
 *   yI1ii: [[albumId], 2] → 公開リンクを作成（「リンクを作成」ボタン）
 *   レスポンスに photos.app.goo.gl URL が含まれる場合はそのまま返す
 *
 * @param {string} apiAlbumId - アルバムID（AF1Qip...形式）
 * @returns {Promise<{shareableUrl?: string, needsReload?: boolean}>}
 */
export async function createAlbumShareLink(apiAlbumId) {
  if (!apiAlbumId) {
    throw new Error('apiAlbumIdが必要です');
  }

  addDebugLog('SHARE', 'yI1ii start', { apiAlbumId });

  const requestData = [[apiAlbumId], 2];
  let resp = null;
  try {
    resp = await makeApiRequest(RPC_IDS.CREATE_PUBLIC_SHARE, requestData, {
      maxRetries: 1,
      sourcePath: `/u/0/share/${apiAlbumId}`,
      useUserPath: true,
      logEmptyPayload: true,
      skipPageId: true,
      extraParams: { 'soc-app': '165', 'soc-platform': '1', 'soc-device': '1' },
    });
    addDebugLog('SHARE', 'yI1ii response', resp);
  } catch (e) {
    // ペイロードなし = 成功扱い（DELETE_ALBUMと同様）
    if (e.message.includes('ペイロードがありません') ||
        e.message.includes('wrb.fr エンベロープが見つかりません') ||
        e.message.includes('空のレスポンス')) {
      addDebugLog('SHARE', 'yI1ii empty payload (ok, needs reload)', {});
      return { needsReload: true };
    }
    addDebugLog('SHARE', 'yI1ii error', { error: e.message });
    throw e;
  }

  // レスポンスから photos.app.goo.gl URL を探す
  const respStr = JSON.stringify(resp);
  const urlMatch = respStr.match(/https:\/\/photos\.app\.goo\.gl\/[A-Za-z0-9]+/);
  if (urlMatch) {
    addDebugLog('SHARE', 'URL found', { url: urlMatch[0] });
    return { shareableUrl: urlMatch[0] };
  }

  // URLがレスポンスにない場合はリロードして再取得が必要
  addDebugLog('SHARE', 'URL not in response, needs reload', {});
  return { needsReload: true };
}

/**
 * 大量の写真を削除（50件ずつバッチ処理）
 *
 * @param {string[]} dedupKeys - 削除する写真のdedupKey配列
 * @param {function} onProgress - 進捗コールバック (processed, total) => void
 * @returns {Promise<number>} 削除成功件数
 */
export async function moveItemsToTrashBatch(dedupKeys, onProgress = null) {
  if (!Array.isArray(dedupKeys) || dedupKeys.length === 0) {
    throw new Error('dedupKeysは空でない配列である必要があります');
  }

  const batchSize = 50;
  let successCount = 0;
  let failedKeys = [];

  for (let i = 0; i < dedupKeys.length; i += batchSize) {
    const batch = dedupKeys.slice(i, i + batchSize);

    try {
      await moveItemsToTrash(batch);
      successCount += batch.length;

      if (onProgress) {
        onProgress(successCount, dedupKeys.length);
      }

      // レートリミット対策
      if (i + batchSize < dedupKeys.length) {
        await sleep(300);
      }
    } catch (error) {
      console.error(`[DELETE] Batch ${i / batchSize + 1} failed:`, error);
      failedKeys.push(...batch);
    }
  }

  if (failedKeys.length > 0) {
    console.warn(`[DELETE] Failed to delete ${failedKeys.length} items`);
  }

  return successCount;
}

// ============================================
// 型定義（JSDoc）
// ============================================

/**
 * @typedef {Object} MediaItem
 * @property {string} mediaKey
 * @property {string} thumb
 * @property {number} resWidth
 * @property {number} resHeight
 * @property {number} timestamp
 * @property {string} dedupKey
 * @property {number} timezoneOffset
 * @property {number} creationTimestamp
 * @property {boolean} isLivePhoto
 * @property {number} livePhotoDuration
 * @property {number} duration
 * @property {string} descriptionShort
 * @property {boolean} isArchived
 * @property {boolean} isFavorite
 * @property {Object} geoLocation
 */

/**
 * @typedef {Object} Album
 * @property {string} mediaKey
 * @property {string} ownerActorId
 * @property {string} title
 * @property {string} thumb
 * @property {number} itemCount
 * @property {number} creationTimestamp
 * @property {number} modifiedTimestamp
 * @property {Array<number>} timestampRange
 * @property {boolean} isShared
 */

/**
 * @typedef {Object} AlbumsPage
 * @property {Album[]} items
 * @property {string|null} nextPageId
 */

/**
 * @typedef {Object} AlbumItemsPage
 * @property {MediaItem[]} items
 * @property {string|null} nextPageId
 * @property {string} mediaKey
 * @property {string} title
 * @property {Object} owner
 * @property {number} itemCount
 * @property {string} authKey
 */

/**
 * @typedef {Object} TimelinePage
 * @property {MediaItem[]} items
 * @property {string|null} nextPageId
 * @property {number|null} lastItemTimestamp
 */

/**
 * 非公式APIでアルバムに写真を追加する
 * RPC ID: laUYf（PC Network検証済み 2026-04-21）
 *
 * @param {string} albumMediaKey - アルバムのmediaKey（AF1Qip...形式）
 * @param {string[]} photoMediaKeys - 追加する写真のmediaKey配列
 */
export async function addPhotosToAlbumWebApi(albumMediaKey, photoMediaKeys) {
  if (!albumMediaKey || !photoMediaKeys?.length) {
    throw new Error('albumMediaKeyとphotoMediaKeysが必要です');
  }

  const requestData = [
    albumMediaKey,
    [2, null, [photoMediaKeys.map(k => [k])], null, null, null, [1], null, null, null, null, null, null, 0],
  ];

  addDebugLog('ADD_TO_ALBUM', 'laUYf start', { albumMediaKey, photoMediaKeys });

  try {
    const response = await makeApiRequest(RPC_IDS.ADD_PHOTOS_TO_ALBUM, requestData, {
      maxRetries: 1,
      sourcePath: `/share/${albumMediaKey}`,
      extraParams: {
        'soc-app': '165',
        'soc-platform': '1',
        'soc-device': '1',
      },
      skipPageId: true,
    });
    addDebugLog('ADD_TO_ALBUM', 'laUYf success', { response });
    return response;
  } catch (error) {
    addDebugLog('ADD_TO_ALBUM', 'laUYf failed', { error: error.message });
    throw error;
  }
}

/**
 * アップロード直後の写真のmediaKeyをタイムラインから取得する
 * creationTimeで照合し、一致する写真のmediaKeyを返す
 *
 * @param {string} creationTimeIso - ISO形式のcreationTime（例: "2026-04-21T11:44:07Z"）
 * @param {number} retries - リトライ回数（Googleの反映待ち）
 * @returns {Promise<string|null>} mediaKey または null
 */
export async function findUploadedPhotoMediaKey(creationTimeIso, retries = 3) {
  const targetMs = new Date(creationTimeIso).getTime();

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, 3000));
    }

    try {
      // targetMsを起点に検索（既存写真・古い写真でも日付付近から取得できる）
      const page = await getItemsByTakenDate(targetMs, 'library', null, 50);
      const match = page.items.find(item => {
        if (!item.creationTimestamp) return false;
        return Math.abs(item.creationTimestamp - targetMs) < 60000; // 1分以内
      });

      if (match) {
        addDebugLog('ADD_TO_ALBUM', 'Found mediaKey via timeline', { mediaKey: match.mediaKey, attempt });
        return match.mediaKey;
      }

      addDebugLog('ADD_TO_ALBUM', `Timeline match not found (attempt ${attempt}/${retries})`);
    } catch (e) {
      addDebugLog('ADD_TO_ALBUM', `Timeline fetch failed (attempt ${attempt})`, { error: e.message });
    }
  }

  return null;
}
