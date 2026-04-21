import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import AsyncStorage from '@react-native-async-storage/async-storage';

WebBrowser.maybeCompleteAuthSession();

// クライアントID
const IOS_CLIENT_ID = '483467707926-haidkv7t2d0vg3pgk7ushjkovvqukdn5.apps.googleusercontent.com';
const WEB_CLIENT_ID = '483467707926-haidkv7t2d0vg3pgk7ushjkovvqukdn5.apps.googleusercontent.com';

const STORAGE_KEY = '@photov_google_auth';
const DEBUG_LOG_KEY = '@photov_debug_log';

// Google Photos APIのスコープ
const SCOPES = [
  'https://www.googleapis.com/auth/photoslibrary.readonly',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/photoslibrary.sharing',
  'https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata',
];

// デバッグログを保存
let debugLogs = [];

export function addDebugLog(category, message, data = null) {
  const log = {
    timestamp: new Date().toISOString(),
    category,
    message,
    data: data ? JSON.stringify(data, null, 2) : null,
  };
  debugLogs.push(log);
  // 最新100件のみ保持
  if (debugLogs.length > 100) {
    debugLogs = debugLogs.slice(-100);
  }
  console.log(`[${category}] ${message}`, data || '');
  // 非同期で保存
  AsyncStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLogs)).catch(() => {});
}

export async function getDebugLogs() {
  try {
    const saved = await AsyncStorage.getItem(DEBUG_LOG_KEY);
    return saved ? JSON.parse(saved) : debugLogs;
  } catch {
    return debugLogs;
  }
}

export async function clearDebugLogs() {
  debugLogs = [];
  await AsyncStorage.removeItem(DEBUG_LOG_KEY);
}

/**
 * Google認証用のhook設定を返す
 */
export function useGoogleAuthConfig() {
  // iOS Native: リバースクライアントIDをスキームとして使用
  // com.googleusercontent.apps.{CLIENT_ID}:/oauth2redirect/google
  const reverseClientId = IOS_CLIENT_ID.split('.').reverse().join('.');

  const redirectUri = `${reverseClientId}:/oauth2redirect/google`;

  // Gemini推奨：OAuth Configログ削除（レンダリングごとに大量出力されるため）
  // addDebugLog('AUTH', 'OAuth Config', {...});

  return Google.useAuthRequest({
    iosClientId: IOS_CLIENT_ID,
    scopes: SCOPES,
  });
}

/**
 * 認証結果を処理してトークンを保存
 */
export async function handleAuthResponse(response) {
  addDebugLog('AUTH', 'Processing auth response', { type: response?.type });
  
  if (response?.type === 'success') {
    const { authentication } = response;
    if (authentication?.accessToken) {
      const authData = {
        accessToken: authentication.accessToken,
        expiresAt: Date.now() + (authentication.expiresIn ? authentication.expiresIn * 1000 : 3600000),
      };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(authData));
      addDebugLog('AUTH', 'Token saved successfully', { expiresAt: authData.expiresAt });
      return authData;
    }
  }
  addDebugLog('AUTH', 'Auth response failed or cancelled');
  return null;
}

/**
 * 保存された認証情報を取得
 */
export async function getStoredAuth() {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (!stored) {
      addDebugLog('AUTH', 'No stored auth found');
      return null;
    }
    
    const authData = JSON.parse(stored);
    
    // トークンが期限切れかチェック
    if (authData.expiresAt < Date.now()) {
      addDebugLog('AUTH', 'Token expired', { expiresAt: authData.expiresAt, now: Date.now() });
      await AsyncStorage.removeItem(STORAGE_KEY);
      return null;
    }
    
    addDebugLog('AUTH', 'Using stored auth', { expiresIn: Math.floor((authData.expiresAt - Date.now()) / 1000) + 's' });
    return authData;
  } catch (error) {
    addDebugLog('AUTH', 'Error getting stored auth', { error: error.message });
    return null;
  }
}

/**
 * 認証情報をクリア
 */
export async function clearAuth() {
  await AsyncStorage.removeItem(STORAGE_KEY);
  addDebugLog('AUTH', 'Auth cleared');
}

/**
 * Google Photos APIにファイルをアップロード
 */
export async function uploadToGooglePhotos(accessToken, fileUri, mimeType, albumId = null) {
  addDebugLog('UPLOAD', 'Starting upload', { fileUri: fileUri.substring(0, 50), mimeType, albumId });
  
  try {
    // Step 1: ファイルをアップロードしてアップロードトークンを取得
    addDebugLog('UPLOAD', 'Step 1: Fetching file blob');
    const fileResponse = await fetch(fileUri);
    const blob = await fileResponse.blob();
    addDebugLog('UPLOAD', 'Blob created', { size: blob.size, type: blob.type });
    
    addDebugLog('UPLOAD', 'Step 2: Uploading to Google Photos');
    const uploadResponse = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': mimeType || 'image/jpeg',
        'X-Goog-Upload-Protocol': 'raw',
      },
      body: blob,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      addDebugLog('UPLOAD', 'Upload failed', { status: uploadResponse.status, error: errorText });
      throw new Error(`Upload failed: ${uploadResponse.status} - ${errorText}`);
    }

    const uploadToken = await uploadResponse.text();
    addDebugLog('UPLOAD', 'Upload token received', { tokenLength: uploadToken.length });

    // Step 3: メディアアイテムを作成（albumId指定なし）
    addDebugLog('UPLOAD', 'Step 3: Creating media item');
    const createBody = {
      newMediaItems: [{
        simpleMediaItem: {
          uploadToken,
        },
      }],
    };

    const createResponse = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createBody),
    });

    const resultText = await createResponse.text();
    addDebugLog('UPLOAD', 'Create response', { status: createResponse.status, body: resultText });

    if (!createResponse.ok) {
      throw new Error(`Create media item failed: ${createResponse.status} - ${resultText}`);
    }

    const result = JSON.parse(resultText);

    // 結果を確認
    if (result.newMediaItemResults) {
      result.newMediaItemResults.forEach((item, idx) => {
        addDebugLog('UPLOAD', `Item ${idx} result`, {
          status: item.status?.message || 'unknown',
          mediaItem: item.mediaItem?.id || 'no id',
        });
      });
    }

    // Step 4: アルバムIDがあれば、明示的にアルバムに追加
    if (albumId && result.newMediaItemResults?.[0]?.mediaItem?.id) {
      const mediaItemId = result.newMediaItemResults[0].mediaItem.id;
      addDebugLog('UPLOAD', 'Step 4: Adding to album via batchAddMediaItems', { albumId, mediaItemId });

      const addResponse = await fetch(`https://photoslibrary.googleapis.com/v1/albums/${albumId}:batchAddMediaItems`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mediaItemIds: [mediaItemId],
        }),
      });

      if (!addResponse.ok) {
        const addErrorText = await addResponse.text();
        addDebugLog('UPLOAD', 'batchAddMediaItems failed', { status: addResponse.status, error: addErrorText });
        result._batchAddFailed = true;
      } else {
        addDebugLog('UPLOAD', 'Successfully added to album');
      }
    }

    return result;
  } catch (error) {
    addDebugLog('UPLOAD', 'Upload error', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * 共有アルバムのリストを取得
 */
export async function listSharedAlbums(accessToken) {
  addDebugLog('API', 'Listing shared albums');
  
  try {
    const response = await fetch('https://photoslibrary.googleapis.com/v1/sharedAlbums', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    
    const result = await response.json();
    addDebugLog('API', 'Shared albums response', { count: result.sharedAlbums?.length || 0 });
    return result;
  } catch (error) {
    addDebugLog('API', 'List shared albums error', { error: error.message });
    throw error;
  }
}

/**
 * アルバム情報を取得（APIのalbumIdで）
 */
export async function getAlbumById(accessToken, albumId) {
  addDebugLog('API', 'Getting album by ID', { albumId });
  
  try {
    const response = await fetch(`https://photoslibrary.googleapis.com/v1/albums/${albumId}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    
    const result = await response.json();
    addDebugLog('API', 'Album info', result);
    return result;
  } catch (error) {
    addDebugLog('API', 'Get album error', { error: error.message });
    throw error;
  }
}

/**
 * 全アルバムをリスト
 */
export async function listAlbums(accessToken) {
  addDebugLog('API', 'Listing all albums');
  
  try {
    const response = await fetch('https://photoslibrary.googleapis.com/v1/albums?pageSize=50', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    
    const result = await response.json();
    addDebugLog('API', 'Albums response', { count: result.albums?.length || 0, error: result.error?.message || null, status: response.status });
    return result;
  } catch (error) {
    addDebugLog('API', 'List albums error', { error: error.message });
    throw error;
  }
}

/**
 * アルバム内の写真を取得
 */
export async function listAlbumPhotos(accessToken, albumId) {
  addDebugLog('API', 'Listing album photos', { albumId });
  
  try {
    const response = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        albumId: albumId,
        pageSize: 100,
      }),
    });
    
    const result = await response.json();
    addDebugLog('API', 'Album photos response', { count: result.mediaItems?.length || 0 });
    return result;
  } catch (error) {
    addDebugLog('API', 'List album photos error', { error: error.message });
    throw error;
  }
}

/**
 * アルバムから写真を削除
 */
export async function removePhotosFromAlbum(accessToken, albumId, mediaItemIds) {
  addDebugLog('API', 'Removing photos from album', { albumId, count: mediaItemIds.length });
  
  try {
    const response = await fetch(`https://photoslibrary.googleapis.com/v1/albums/${albumId}:batchRemoveMediaItems`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mediaItemIds: mediaItemIds,
      }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to remove photos');
    }
    
    addDebugLog('API', 'Photos removed successfully');
    return { success: true };
  } catch (error) {
    addDebugLog('API', 'Remove photos error', { error: error.message });
    throw error;
  }
}

/**
 * 新しいアルバムを作成
 */
export async function createAlbum(accessToken, title) {
  addDebugLog('API', 'Creating album', { title });
  
  try {
    const response = await fetch('https://photoslibrary.googleapis.com/v1/albums', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        album: { title },
      }),
    });
    
    const result = await response.json();
    addDebugLog('API', 'Create album response', result);
    
    if (result.error) {
      throw new Error(result.error.message || 'アルバム作成に失敗しました');
    }
    
    return result;
  } catch (error) {
    addDebugLog('API', 'Create album error', { error: error.message });
    throw error;
  }
}

/**
 * アルバムのタイトルを更新
 *
 * @param {string} accessToken - アクセストークン
 * @param {string} albumId - アルバムID
 * @param {string} newTitle - 新しいタイトル
 * @returns {Promise<object>} 更新されたアルバム情報
 */
export async function updateAlbumTitle(accessToken, albumId, newTitle) {
  addDebugLog('API', 'Updating album title', { albumId, newTitle });

  try {
    const response = await fetch(
      `https://photoslibrary.googleapis.com/v1/albums/${albumId}?updateMask=title`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: newTitle,
        }),
      }
    );

    const result = await response.json();
    addDebugLog('API', 'Update album title response', result);

    if (result.error) {
      throw new Error(result.error.message || 'アルバム名の変更に失敗しました');
    }

    return result;
  } catch (error) {
    addDebugLog('API', 'Update album title error', { error: error.message });
    throw error;
  }
}

/**
 * アルバムのカバー写真を設定
 *
 * @param {string} accessToken - アクセストークン
 * @param {string} albumId - アルバムID
 * @param {string} mediaItemId - カバー写真にする写真のmediaItemId
 * @returns {Promise<object>} 更新されたアルバム情報
 */
export async function setCoverPhoto(accessToken, albumId, mediaItemId) {
  addDebugLog('API', 'Setting cover photo', { albumId, mediaItemId });

  try {
    const response = await fetch(
      `https://photoslibrary.googleapis.com/v1/albums/${albumId}?updateMask=coverPhotoMediaItemId`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          coverPhotoMediaItemId: mediaItemId,
        }),
      }
    );

    const result = await response.json();
    addDebugLog('API', 'Set cover photo response', result);

    if (result.error) {
      throw new Error(result.error.message || 'カバー写真の設定に失敗しました');
    }

    return result;
  } catch (error) {
    addDebugLog('API', 'Set cover photo error', { error: error.message });
    throw error;
  }
}

/**
 * APP_CREATED_ALBUMSのデータ構造を移行
 * 旧: {title: {apiAlbumId, ...}}
 * 新: {apiAlbumId: {title, originalTitle, ...}}
 */
export async function migrateAppCreatedAlbums() {
  try {
    const STORAGE_KEY = '@photov_app_created_albums';
    const savedAlbums = await AsyncStorage.getItem(STORAGE_KEY);

    if (!savedAlbums) {
      addDebugLog('MIGRATION', 'No albums to migrate');
      return { migrated: false, reason: 'no_data' };
    }

    const albumsData = JSON.parse(savedAlbums);

    // 既に新しい構造か確認（キーがapiAlbumIdの形式：長い英数字）
    const keys = Object.keys(albumsData);
    if (keys.length > 0) {
      const firstKey = keys[0];
      const firstValue = albumsData[firstKey];

      // 新しい構造の判定：キーが長く、値にtitleプロパティがある
      if (firstKey.length > 20 && firstValue.title) {
        addDebugLog('MIGRATION', 'Already migrated to new structure');
        return { migrated: false, reason: 'already_new' };
      }
    }

    // 古い構造から新しい構造に変換
    const newStructure = {};
    let migratedCount = 0;

    for (const [title, data] of Object.entries(albumsData)) {
      if (data.apiAlbumId) {
        newStructure[data.apiAlbumId] = {
          title: title,  // 現在のタイトル
          originalTitle: title,  // 元のタイトル
          shareableUrl: data.shareableUrl,
          createdAt: data.createdAt,
        };
        migratedCount++;
      }
    }

    // 新しい構造で保存
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newStructure));
    addDebugLog('MIGRATION', `Migrated ${migratedCount} albums to new structure`);

    return { migrated: true, count: migratedCount };
  } catch (error) {
    addDebugLog('MIGRATION', `Migration error: ${error.message}`);
    throw error;
  }
}

/**
 * 公式APIからアルバム一覧を取得し、APP_CREATED_ALBUMSに登録
 * Google Photosでリネームされたアルバムも復元
 */
export async function syncAppCreatedAlbums(accessToken) {
  try {
    addDebugLog('SYNC', 'Syncing app created albums with Google Photos API');

    // 公式APIでアルバム一覧を取得
    const result = await listAlbums(accessToken);
    const albums = result.albums || [];

    const STORAGE_KEY = '@photov_app_created_albums';
    const savedAlbums = await AsyncStorage.getItem(STORAGE_KEY);
    const existingData = savedAlbums ? JSON.parse(savedAlbums) : {};

    let syncedCount = 0;
    let newCount = 0;

    // 共有アルバム（PhotoVで作成した可能性が高い）を検索
    for (const album of albums) {
      if (album.shareInfo && album.id) {
        // 既に登録されているか確認
        if (!existingData[album.id]) {
          // 新規追加
          existingData[album.id] = {
            title: album.title,
            originalTitle: album.title,
            shareableUrl: album.shareInfo.shareableUrl,
            createdAt: new Date().toISOString(),
            syncedAt: new Date().toISOString(),
          };
          newCount++;
        } else {
          // タイトルを更新
          existingData[album.id].title = album.title;
          existingData[album.id].syncedAt = new Date().toISOString();
        }
        syncedCount++;
      }
    }

    // 保存
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(existingData));
    addDebugLog('SYNC', `Synced ${syncedCount} albums (${newCount} new)`);

    return { synced: syncedCount, new: newCount };
  } catch (error) {
    addDebugLog('SYNC', `Sync error: ${error.message}`);
    throw error;
  }
}

/**
 * アルバムを共有設定にする
 */
export async function shareAlbum(accessToken, albumId) {
  addDebugLog('API', 'Sharing album', { albumId });
  
  try {
    const response = await fetch(`https://photoslibrary.googleapis.com/v1/albums/${albumId}:share`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sharedAlbumOptions: {
          isCollaborative: true,
          isCommentable: true,
        },
      }),
    });
    
    const result = await response.json();
    addDebugLog('API', 'Share album response', result);
    
    if (result.error) {
      throw new Error(result.error.message || 'アルバム共有に失敗しました');
    }
    
    return result;
  } catch (error) {
    addDebugLog('API', 'Share album error', { error: error.message });
    throw error;
  }
}
