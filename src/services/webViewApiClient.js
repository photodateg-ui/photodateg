/**
 * WebView内でGoogle Photos APIを実行するクライアント
 * 
 * WebViewのCookieを使うため、injectJavaScript + postMessageで通信する
 */

// RPC ID 定義
const RPC_IDS = {
  GET_ALBUMS: 'Z5xsfc',
  GET_ALBUM_PAGE: 'snAcKc',
  GET_ITEMS_BY_DATE: 'lcxiM',
};

/**
 * WebView内で実行するAPIリクエストのJavaScriptコードを生成
 */
export function generateApiRequestScript(requestId, rpcid, requestData, sessionData) {
  const { at, sid, bl } = sessionData;
  
  const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
  const requestBody = `f.req=${encodeURIComponent(JSON.stringify(wrappedData))}&at=${encodeURIComponent(at)}&`;
  
  const params = new URLSearchParams({
    rpcids: rpcid,
    'source-path': '/u/0/photos',
    'f.sid': sid,
    bl: bl,
    pageId: 'none',
    rt: 'c',
    _cb: Date.now(), // キャッシュバスター
  });
  
  const url = `https://photos.google.com/_/PhotosUi/data/batchexecute?${params.toString()}`;
  
  // WebView内で実行されるスクリプト
  return `
    (async function() {
      const requestId = '${requestId}';
      try {
        const response = await fetch('${url}', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'Cache-Control': 'no-cache, no-store',
          },
          body: '${requestBody.replace(/'/g, "\\'")}',
          credentials: 'include',
          cache: 'no-store',
        });
        
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        }
        
        const responseBody = await response.text();
        
        if (!responseBody) {
          throw new Error('空のレスポンス');
        }
        
        // wrb.fr エンベロープを探す
        const lines = responseBody.split('\\n');
        let jsonLine = null;
        for (const line of lines) {
          if (line.includes('wrb.fr')) {
            jsonLine = line;
            break;
          }
        }
        
        if (!jsonLine) {
          throw new Error('wrb.fr エンベロープが見つかりません');
        }
        
        const parsedData = JSON.parse(jsonLine);
        
        if (!parsedData || !parsedData[0] || !parsedData[0][2]) {
          throw new Error('レスポンスにペイロードがありません');
        }
        
        const payload = JSON.parse(parsedData[0][2]);
        
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'API_RESPONSE',
          requestId: requestId,
          success: true,
          data: payload,
        }));
      } catch (error) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'API_RESPONSE',
          requestId: requestId,
          success: false,
          error: error.message,
        }));
      }
    })();
    true;
  `;
}

/**
 * アルバム一覧取得用のスクリプトを生成
 */
export function generateGetAlbumsScript(requestId, sessionData, pageId = null, pageSize = 100) {
  const requestData = [pageId, null, null, null, 1, null, null, pageSize, [2], 5];
  return generateApiRequestScript(requestId, RPC_IDS.GET_ALBUMS, requestData, sessionData);
}

/**
 * アルバム内写真取得用のスクリプトを生成
 */
export function generateGetAlbumPageScript(requestId, sessionData, albumMediaKey, pageId = null, authKey = null) {
  const requestData = [albumMediaKey, pageId, null, authKey];
  return generateApiRequestScript(requestId, RPC_IDS.GET_ALBUM_PAGE, requestData, sessionData);
}

/**
 * タイムライン取得用のスクリプトを生成
 */
export function generateGetTimelineScript(requestId, sessionData, timestamp = null, source = null, pageId = null, pageSize = 500) {
  let sourceCode;
  if (source === 'library') sourceCode = 1;
  else if (source === 'archive') sourceCode = 2;
  else sourceCode = 3;
  
  const requestData = [pageId, timestamp, pageSize, null, 1, sourceCode];
  return generateApiRequestScript(requestId, RPC_IDS.GET_ITEMS_BY_DATE, requestData, sessionData);
}

// ============================================
// パーサー関数（googlePhotosWebApi.jsから移植）
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
export function parseAlbumsResponse(data) {
  return {
    items: data?.[0]?.map(item => parseAlbum(item)).filter(Boolean) || [],
    nextPageId: data?.[1] || null,
  };
}

/**
 * アルバム内アイテムページをパース
 */
export function parseAlbumItemsResponse(data) {
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
export function parseTimelineResponse(data) {
  return {
    items: data?.[0]?.map(item => parseMediaItem(item)).filter(Boolean) || [],
    nextPageId: data?.[1] || null,
    lastItemTimestamp: parseInt(data?.[2]) || null,
  };
}

// ============================================
// ユーティリティ関数
// ============================================

/**
 * サムネイルURLを生成
 */
export function getPhotoUrl(baseThumb, width = 400, height = 400, crop = true) {
  if (!baseThumb) return null;
  // ローカルURI（アップロード直後の楽観的表示）はそのまま返す
  if (baseThumb.startsWith('file://') || baseThumb.startsWith('ph://')) {
    return baseThumb;
  }
  const baseUrl = baseThumb.split('=')[0];
  const params = crop ? `=w${width}-h${height}-c` : `=w${width}-h${height}`;
  return `${baseUrl}${params}`;
}

/**
 * フルサイズ画像URLを生成
 */
export function getFullSizeUrl(baseThumb, maxWidth = 4096, maxHeight = 4096) {
  if (!baseThumb) return null;
  const baseUrl = baseThumb.split('=')[0];
  return `${baseUrl}=w${maxWidth}-h${maxHeight}`;
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
 * 一意のリクエストIDを生成
 */
export function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
