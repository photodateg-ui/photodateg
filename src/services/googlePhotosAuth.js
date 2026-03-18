import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { GOOGLE_AUTH_CONFIG } from '../config/googleAuth';

// WebBrowserセッションを適切に終了
WebBrowser.maybeCompleteAuthSession();

// Expo Go内かスタンドアロンビルドかを判定
const isExpoGo = Constants.appOwnership === 'expo';

/**
 * Google Photos APIの認証フックを作成
 * @returns {Object} 認証情報とメソッド
 */
export function useGooglePhotosAuth() {
  const clientId = isExpoGo 
    ? GOOGLE_AUTH_CONFIG.webClientId 
    : GOOGLE_AUTH_CONFIG.iosClientId;
  
  const redirectUri = isExpoGo 
    ? GOOGLE_AUTH_CONFIG.expoRedirectUri
    : GOOGLE_AUTH_CONFIG.iosRedirectUri;
  
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId,
      scopes: GOOGLE_AUTH_CONFIG.scopes,
      redirectUri,
      // Expo Goではimplicit flow (token)、スタンドアロンではPKCE (code)
      responseType: isExpoGo ? 'token' : 'code',
      usePKCE: !isExpoGo,
      extraParams: {
        prompt: 'consent',
        access_type: 'offline',
      },
    },
    GOOGLE_AUTH_CONFIG.discovery
  );

  return {
    request,
    response,
    promptAsync,
    redirectUri,
    isExpoGo,
    clientId,
  };
}

// ============================================
// Picker API Functions
// ============================================

const PICKER_API_BASE = 'https://photospicker.googleapis.com/v1';

/**
 * Picker APIセッションを作成
 * @param {string} accessToken - OAuth アクセストークン
 * @returns {Promise<Object>} セッション情報（id, pickerUri, pollingConfig等）
 */
export async function createPickerSession(accessToken) {
  const response = await fetch(`${PICKER_API_BASE}/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`セッション作成失敗: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * Picker セッションの状態を取得
 * @param {string} accessToken - OAuth アクセストークン
 * @param {string} sessionId - セッションID
 * @returns {Promise<Object>} セッション情報（mediaItemsSet, pollingConfig含む）
 */
export async function getPickerSession(accessToken, sessionId) {
  const response = await fetch(`${PICKER_API_BASE}/sessions/${sessionId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`セッション取得失敗: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * 選択されたメディアアイテムを取得（ページネーション対応）
 * @param {string} accessToken - OAuth アクセストークン
 * @param {string} sessionId - セッションID
 * @param {string} [pageToken] - 次ページのトークン
 * @returns {Promise<Object>} { mediaItems, nextPageToken }
 */
export async function listPickedMediaItems(accessToken, sessionId, pageToken = null) {
  let url = `${PICKER_API_BASE}/mediaItems?sessionId=${sessionId}`;
  if (pageToken) {
    url += `&pageToken=${encodeURIComponent(pageToken)}`;
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`メディア取得失敗: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return {
    mediaItems: data.mediaItems || [],
    nextPageToken: data.nextPageToken || null,
  };
}

/**
 * 全ての選択されたメディアアイテムを取得（自動ページネーション）
 * @param {string} accessToken - OAuth アクセストークン
 * @param {string} sessionId - セッションID
 * @returns {Promise<Array>} 全メディアアイテムの配列
 */
export async function listAllPickedMediaItems(accessToken, sessionId) {
  const allItems = [];
  let pageToken = null;

  do {
    const result = await listPickedMediaItems(accessToken, sessionId, pageToken);
    allItems.push(...result.mediaItems);
    pageToken = result.nextPageToken;
  } while (pageToken);

  return allItems;
}

/**
 * Picker セッションを削除
 * セッションの削除はメディアアイテムのコンテンツ取得後に行うこと
 * @param {string} accessToken - OAuth アクセストークン
 * @param {string} sessionId - セッションID
 */
export async function deletePickerSession(accessToken, sessionId) {
  try {
    const response = await fetch(`${PICKER_API_BASE}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    
    if (!response.ok) {
      console.warn('セッション削除失敗:', response.status);
    }
  } catch (error) {
    // 削除失敗は致命的ではないので無視
    console.warn('セッション削除失敗（無視）:', error.message);
  }
}

/**
 * Picker URIを開いてユーザーに写真を選択させる
 * @param {string} pickerUri - Picker URI
 * @returns {Promise<Object>} WebBrowser result
 */
export async function openPhotoPicker(pickerUri) {
  // /autocloseを追加して、選択完了後に自動でタブを閉じる（Webベースアプリの場合）
  const uriWithAutoclose = `${pickerUri}/autoclose`;
  return WebBrowser.openBrowserAsync(uriWithAutoclose);
}

/**
 * セッションをポーリングして選択完了を待つ
 * Google公式のpollingConfigに従ったポーリング実装
 * 
 * @param {string} accessToken - OAuth アクセストークン
 * @param {string} sessionId - セッションID
 * @param {Object} initialPollingConfig - 初期セッションから取得したpollingConfig
 * @returns {Promise<{completed: boolean, timedOut: boolean}>}
 */
export async function waitForMediaSelection(accessToken, sessionId, initialPollingConfig = null) {
  // デフォルト値（initialPollingConfigがない場合のフォールバック）
  const DEFAULT_POLL_INTERVAL_MS = 3000;  // 3秒
  const DEFAULT_TIMEOUT_MS = 300000;      // 5分

  let pollInterval = initialPollingConfig?.pollInterval 
    ? parseDuration(initialPollingConfig.pollInterval) 
    : DEFAULT_POLL_INTERVAL_MS;
  
  let timeout = initialPollingConfig?.timeoutIn 
    ? parseDuration(initialPollingConfig.timeoutIn) 
    : DEFAULT_TIMEOUT_MS;

  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const session = await getPickerSession(accessToken, sessionId);
      
      if (session.mediaItemsSet) {
        return { completed: true, timedOut: false };
      }
      
      // pollingConfigが更新されている場合は反映
      if (session.pollingConfig) {
        if (session.pollingConfig.pollInterval) {
          pollInterval = parseDuration(session.pollingConfig.pollInterval);
        }
        if (session.pollingConfig.timeoutIn) {
          const newTimeout = parseDuration(session.pollingConfig.timeoutIn);
          // 残り時間を再計算
          timeout = Math.min(timeout, Date.now() - startTime + newTimeout);
        }
      }
    } catch (error) {
      console.warn('ポーリングエラー（リトライ）:', error.message);
    }
    
    await sleep(pollInterval);
  }
  
  return { completed: false, timedOut: true };
}

/**
 * Google API形式の期間文字列（例: "3s", "300s"）をミリ秒に変換
 * @param {string} duration - 期間文字列
 * @returns {number} ミリ秒
 */
function parseDuration(duration) {
  if (typeof duration === 'number') {
    return duration;
  }
  
  if (typeof duration === 'string') {
    // "3s" -> 3000, "300s" -> 300000
    const match = duration.match(/^(\d+(?:\.\d+)?)(s|ms)?$/);
    if (match) {
      const value = parseFloat(match[1]);
      const unit = match[2] || 's';
      return unit === 'ms' ? value : value * 1000;
    }
  }
  
  return 3000; // デフォルト3秒
}

/**
 * 指定ミリ秒待機
 * @param {number} ms - ミリ秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Base URL Utilities
// ============================================

/**
 * Picker APIのmediaItemからサムネイルURLを構築
 * @param {Object} mediaItem - Picker APIから取得したメディアアイテム
 * @param {number} width - 幅
 * @param {number} height - 高さ
 * @param {boolean} crop - クロップするかどうか
 * @returns {string|null} 画像URL
 */
export function getThumbnailUrl(mediaItem, width = 400, height = 400, crop = true) {
  const baseUrl = mediaItem.mediaFile?.baseUrl || mediaItem.baseUrl;
  if (!baseUrl) return null;
  
  const params = crop ? `=w${width}-h${height}-c` : `=w${width}-h${height}`;
  return `${baseUrl}${params}`;
}

/**
 * Picker APIのmediaItemからフルサイズ画像URLを構築
 * @param {Object} mediaItem - Picker APIから取得したメディアアイテム
 * @param {number} maxWidth - 最大幅
 * @param {number} maxHeight - 最大高さ
 * @returns {string|null} 画像URL
 */
export function getFullSizeUrl(mediaItem, maxWidth = 4096, maxHeight = 4096) {
  const baseUrl = mediaItem.mediaFile?.baseUrl || mediaItem.baseUrl;
  if (!baseUrl) return null;
  
  return `${baseUrl}=w${maxWidth}-h${maxHeight}`;
}

/**
 * 動画をダウンロードするURLを構築
 * @param {Object} mediaItem - Picker APIから取得したメディアアイテム
 * @returns {string|null} 動画URL
 */
export function getVideoUrl(mediaItem) {
  const baseUrl = mediaItem.mediaFile?.baseUrl || mediaItem.baseUrl;
  if (!baseUrl) return null;
  
  return `${baseUrl}=dv`;
}

/**
 * メディアアイテムが動画かどうかを判定
 * @param {Object} mediaItem - メディアアイテム
 * @returns {boolean}
 */
export function isVideo(mediaItem) {
  const mimeType = mediaItem.mediaFile?.mimeType || mediaItem.mimeType || '';
  return mimeType.startsWith('video/');
}
