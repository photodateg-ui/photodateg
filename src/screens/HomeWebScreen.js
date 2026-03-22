import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  ScrollView,
  Dimensions,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  RefreshControl,
  AppState,
  Linking,
  Share,
  Modal,
  TextInput,
} from 'react-native';
import { Image } from 'expo-image';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import {
  useGoogleAuthConfig,
  handleAuthResponse,
  getStoredAuth,
  uploadToGooglePhotos,
  clearAuth,
  addDebugLog,
  getDebugLogs,
  clearDebugLogs,
  listAlbums,
  listAlbumPhotos,
  removePhotosFromAlbum,
  updateAlbumTitle,
  setCoverPhoto,
} from '../services/googleAuthService';
import {
  getPhotoUrl,
  getFullSizeUrl,
  isVideoItem,
  timestampToDate,
  generateGetAlbumPageScript,
  generateGetAlbumsScript,
  parseAlbumItemsResponse,
  parseAlbumsResponse,
  generateRequestId,
} from '../services/webViewApiClient';
import {
  moveItemsToTrash,
  moveItemsToTrashBatch,
  getAlbumPage,
  deleteAlbum,
  sessionManager,
} from '../services/googlePhotosWebApi';

const { width } = Dimensions.get('window');
const numColumns = 3;

// Gemini推奨：WebView内部で自律的に準備完了を通知するスクリプト
const INIT_SCRIPT = `
  (function() {
    // 1. グローバルにチェック関数を定義
    window.checkReady = function() {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'WEBVIEW_READY' }));
    };

    // 2. ページ読み込み完了時に即座に通知
    if (document.readyState === 'complete') {
      window.checkReady();
    } else {
      window.addEventListener('load', window.checkReady);
    }
  })();
  true; // 必須：最後にtrueを返さないとAndroidで動かない場合がある
`;
const imageSize = width / numColumns;

const STORAGE_KEYS = {
  SELECTED_ALBUM: '@photov_selected_album',
  SESSION_DATA: '@photov_session_data',
  APP_CREATED_ALBUMS: '@photov_app_created_albums',
};

// 日付を日本語フォーマットに変換
const formatDateJapanese = (timestamp) => {
  if (!timestamp) return '日付不明';
  
  const date = timestampToDate(timestamp);
  if (!date || isNaN(date.getTime())) return '日付不明';
  
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const weekday = weekdays[date.getDay()];
  return `${month}月${day}日(${weekday})`;
};

// 写真を日付でグループ化
const groupPhotosByDate = (photos) => {
  const groups = {};

  photos.forEach(photo => {
    const timestamp = photo.timestamp || photo.creationTimestamp;
    const date = timestampToDate(timestamp);
    const dateKey = date ? date.toDateString() : 'Unknown';

    if (!groups[dateKey]) {
      groups[dateKey] = {
        timestamp: timestamp,
        items: [],
      };
    }
    groups[dateKey].items.push(photo);
  });

  return Object.keys(groups)
    .sort((a, b) => {
      if (a === 'Unknown') return 1;
      if (b === 'Unknown') return -1;
      return new Date(b) - new Date(a);
    })
    .map(dateKey => ({
      title: formatDateJapanese(groups[dateKey].timestamp),
      data: groups[dateKey].items,
      dateKey,
    }));
};

// 配列を指定サイズでチャンク分割
const chunkArray = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

// 個別の写真アイテムコンポーネント（expo-image使用で高速キャッシュ）
const PhotoItem = React.memo(({ photo, onPress, onLongPress, selectionMode, isSelected }) => {
  const photoUrl = getPhotoUrl(photo.thumb, 200, 200, true);
  const isVideo = isVideoItem(photo);

  return (
    <TouchableOpacity
      style={styles.photoContainer}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.8}
      delayLongPress={300}
    >
      {photoUrl ? (
        <View style={styles.photoInner}>
          <Image
            source={{ uri: photoUrl }}
            style={[styles.photo, isSelected && styles.selectedPhoto]}
            contentFit="cover"
            transition={0}
            cachePolicy="memory-disk"
            recyclingKey={photo.mediaKey}
            priority="normal"
          />
          {isVideo && (
            <View style={styles.videoIndicator}>
              <Text style={styles.videoIndicatorText}>▶</Text>
              {photo.duration && (
                <Text style={styles.durationText}>
                  {Math.floor(photo.duration / 60)}:{String(photo.duration % 60).padStart(2, '0')}
                </Text>
              )}
            </View>
          )}
          {photo.isLivePhoto && (
            <View style={styles.livePhotoBadge}>
              <Text style={styles.livePhotoText}>LIVE</Text>
            </View>
          )}
          {selectionMode && (
            <View style={[styles.selectionIndicator, isSelected && styles.selectionIndicatorSelected]}>
              {isSelected && <Text style={styles.checkmark}>✓</Text>}
            </View>
          )}
        </View>
      ) : (
        <View style={[styles.photoInner, styles.placeholderPhoto]}>
          <Text style={styles.placeholderText}>📷</Text>
        </View>
      )}
    </TouchableOpacity>
  );
});

export default function HomeWebScreen({ route, navigation }) {
  const [photos, setPhotos] = useState([]);
  const [photoSections, setPhotoSections] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, total: 0 });
  const [error, setError] = useState(null);

  // Geminiの提案：画面がフォーカスされているかリアルタイムに取得
  const isFocused = useIsFocused();
  const [sessionData, setSessionData] = useState(null);
  const [pendingUploadAssets, setPendingUploadAssets] = useState(null);
  const [showDebugMenu, setShowDebugMenu] = useState(false);
  const [debugLogs, setDebugLogs] = useState([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPhotos, setSelectedPhotos] = useState(new Set());
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAlbumInitialized, setIsAlbumInitialized] = useState(false); // アルバム情報の初期化完了フラグ

  // Gemini推奨：WebViewリセット用のkey
  const [webViewKey, setWebViewKey] = useState(0);

  // Gemini推奨：アップロード後のポーリング状態
  const [isPollingForUpload, setIsPollingForUpload] = useState(false);
  const [pollingAttempts, setPollingAttempts] = useState(0);
  const MAX_POLLING_ATTEMPTS = 10; // 最大10回（10秒）
  const POLLING_INTERVAL = 1000; // 1秒ごと

  const webViewRef = useRef(null);
  const pendingRequests = useRef(new Map()); // Gemini推奨：複数リクエスト管理用Map
  const isLoadingPhotos = useRef(false); // Gemini推奨：多重実行抑制フラグ
  const appState = useRef(AppState.currentState);
  const wasInBackground = useRef(false);
  const titleTapCount = useRef(0);
  const titleTapTimer = useRef(null);
  const pollingTimerRef = useRef(null); // ポーリングタイマー
  const shouldStopPolling = useRef(false); // ポーリング停止フラグ
  const hasOptimisticUpdate = useRef(false); // アップロード楽観的更新フラグ

  // Google認証hook
  const [googleRequest, googleResponse, promptGoogleAsync] = useGoogleAuthConfig();

  // Gemini推奨：route.paramsではなくstateでアルバム情報を管理
  const [albumInfo, setAlbumInfo] = useState({
    mediaKey: route.params?.albumMediaKey || null,
    title: route.params?.albumTitle || 'ファミリーボルト',
    authKey: route.params?.authKey || null,
    apiAlbumId: route.params?.apiAlbumId || null,
  });

  // アルバムリネーム用State
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [newAlbumTitle, setNewAlbumTitle] = useState('');

  // カバー写真選択モード
  const [isCoverPhotoMode, setIsCoverPhotoMode] = useState(route.params?.selectCoverPhoto || false);

  // 既存の変数名を維持（後方互換性）
  const albumMediaKey = albumInfo.mediaKey;
  const albumTitle = albumInfo.title;
  const authKey = albumInfo.authKey;
  const apiAlbumId = albumInfo.apiAlbumId

  // セッションデータを読み込み
  useEffect(() => {
    loadSessionData();
  }, []);

  // AppState監視（バックグラウンド→フォアグラウンド復帰時の処理）
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        console.log('📱 App returned to foreground');
        // バックグラウンドにいた場合、pendingRequestsをすべてクリアしてWebViewをリセット
        if (wasInBackground.current) {
          wasInBackground.current = false;
          if (pendingRequests.current.size > 0) {
            console.log('Cancelling all pending requests after background:', pendingRequests.current.size);
            pendingRequests.current.clear();
          }

          // Gemini推奨：webViewKeyを更新してWebViewを再マウント
          setWebViewKey(prev => prev + 1);
          setIsWebViewReady(false);
          console.log('📱 WebView key updated for foreground return, triggering remount');
        }
      } else if (nextAppState.match(/inactive|background/)) {
        console.log('📱 App going to background');
        wasInBackground.current = true;
      }
      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const loadSessionData = async () => {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_DATA);
      console.log('📂 Loaded session data:', saved ? 'exists' : 'null');
      if (saved) {
        const data = JSON.parse(saved);
        console.log('📂 Session keys:', Object.keys(data));
        if (data.wizData) {
          const sd = {
            at: data.wizData.SNlM0e,
            sid: data.wizData.FdrFJe,
            bl: data.wizData.cfb2h,
          };
          console.log('📂 Setting sessionData:', sd.at ? 'has at' : 'no at');
          setSessionData(sd);
          
          // sessionManagerも初期化（削除APIで使用）
          if (!sessionManager.isValid) {
            sessionManager.setFromWizData(data.wizData);
            console.log('📂 Initialized sessionManager:', sessionManager.isValid ? 'valid' : 'invalid');
          }
          return;
        }
      }
      // セッションがない → WebAuthへ
      console.log('📂 No valid session, redirecting to WebAuth');
      navigation.replace('WebAuth');
    } catch (err) {
      console.error('セッション読み込みエラー:', err);
      navigation.replace('WebAuth');
    }
  };

  // WebViewからのメッセージを処理
  const handleWebViewMessage = useCallback((event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      console.log('📩 WebView message:', message.type, message.requestId || '');

      // WebView準備完了メッセージ
      if (message.type === 'WEBVIEW_READY') {
        console.log('✅ WebView preparation complete');
        addDebugLog('WEBVIEW', 'WebView is ready');
        setIsWebViewReady(true); // Stateを更新
        return;
      }

      // Gemini推奨：Mapから該当リクエストを取得
      if (message.type === 'API_RESPONSE') {
        const request = pendingRequests.current.get(message.requestId);

        if (request) {
          console.log('✅ Matching request found:', message.requestId);
          if (message.success) {
            request.resolve(message.data);
          } else {
            request.reject(new Error(message.error || 'Unknown error'));
          }
          // 処理が終わったら削除
          pendingRequests.current.delete(message.requestId);
        } else {
          console.warn('⚠️ No matching request for ID:', message.requestId);
        }
      }

      if (message.type === 'UPLOAD_RESPONSE') {
        const request = pendingRequests.current.get(message.requestId);

        if (request) {
          console.log('✅ Matching upload request found:', message.requestId);
          if (message.success) {
            request.resolve(message.data);
          } else {
            request.reject(new Error(message.error || 'Upload failed'));
          }
          pendingRequests.current.delete(message.requestId);
        } else {
          console.warn('⚠️ No matching upload request for ID:', message.requestId);
        }
      }
    } catch (err) {
      console.error('メッセージ処理エラー:', err);
    }
  }, []);

  const handleWebViewLoadEnd = useCallback((syntheticEvent) => {
    const currentUrl = syntheticEvent?.nativeEvent?.url || '';
    console.log('🌐 HomeWeb WebView loaded:', currentUrl);

    // ログインページにリダイレクトされた場合、WebAuthへ
    if (currentUrl.includes('accounts.google.com')) {
      console.log('セッション切れ検出、WebAuthへ遷移');
      navigation.replace('WebAuth');
      return;
    }

    // Gemini推奨：injectedJavaScriptプロップを使うため、ここでのinjectJavaScriptは不要
    // WebViewが自律的にWEBVIEW_READYを送信する
  }, [navigation]);

  // Gemini推奨：AsyncStorageからアルバムを読み込み、stateで管理
  useEffect(() => {
    const initializeAlbum = async () => {
      // route.paramsから初期化された場合はスキップ
      if (route.params?.isFromAutoLoad) {
        console.log('📂 [INIT] Already initialized from route.params');
        setAlbumInfo({
          mediaKey: route.params.albumMediaKey || null,
          title: route.params.albumTitle || 'ファミリーボルト',
          authKey: route.params.authKey || null,
          apiAlbumId: route.params.apiAlbumId || null,
        });
        setIsAlbumInitialized(true);
        return;
      }

      // route.paramsがある場合もスキップ（通常のアルバム選択）
      if (route.params?.albumMediaKey || route.params?.apiAlbumId) {
        console.log('📂 [INIT] Initialized from route.params');
        setIsAlbumInitialized(true);
        return;
      }

      try {
        const savedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
        if (savedAlbum) {
          const album = JSON.parse(savedAlbum);
          console.log('📂 [INIT] Found saved album, updating state...');
          console.log('📂 [INIT] Album data:', JSON.stringify(album));

          // Gemini推奨：navigation.replaceではなく、stateを更新
          setAlbumInfo({
            mediaKey: album.mediaKey,
            title: album.title,
            authKey: album.authKey,
            apiAlbumId: album.apiAlbumId,
          });
          console.log('📂 [INIT] Album info updated');
          setIsAlbumInitialized(true);
        } else {
          // 保存されたアルバムがない → アルバム選択へ
          navigation.replace('AlbumSelectWeb');
        }
      } catch (err) {
        console.error('アルバム読み込みエラー:', err);
        navigation.replace('AlbumSelectWeb');
      }
    };

    initializeAlbum();
  }, [navigation]);

  // mediaKeyがない場合、WebViewでアルバム一覧を取得して同名のアルバムを探す
  const findingMediaKeyRef = useRef(false);
  useEffect(() => {
    const findMediaKeyForAlbum = async () => {
      // 条件チェック
      if (albumMediaKey || !albumTitle || !isWebViewReady || !sessionData || findingMediaKeyRef.current) {
        return;
      }
      
      findingMediaKeyRef.current = true;
      addDebugLog('INIT', `Finding mediaKey for album: ${albumTitle}`);
      
      try {
        const requestId = generateRequestId();
        const script = generateGetAlbumsScript(requestId, sessionData);

        // Gemini推奨：Mapで管理
        const responsePromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (pendingRequests.current.has(requestId)) {
              pendingRequests.current.delete(requestId);
            }
            reject(new Error('アルバム一覧の取得がタイムアウトしました'));
          }, 15000);

          pendingRequests.current.set(requestId, {
            resolve: (data) => {
              clearTimeout(timeout);
              resolve(data);
            },
            reject: (error) => {
              clearTimeout(timeout);
              reject(error);
            },
          });
        });

        webViewRef.current?.injectJavaScript(script);

        const response = await responsePromise;
        const parsed = parseAlbumsResponse(response);
        
        addDebugLog('INIT', `Found ${parsed.items.length} albums`);
        
        // 同名のアルバムを探す（完全一致優先）
        const matchingAlbum = parsed.items.find(a => a.title === albumTitle);
        
        if (matchingAlbum) {
          addDebugLog('INIT', `Found matching album: ${matchingAlbum.title}, mediaKey: ${matchingAlbum.mediaKey}`);
          
          // AsyncStorageを更新
          const savedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
          if (savedAlbum) {
            const album = JSON.parse(savedAlbum);
            album.mediaKey = matchingAlbum.mediaKey;
            await AsyncStorage.setItem(STORAGE_KEYS.SELECTED_ALBUM, JSON.stringify(album));
          }
          
          // navigation paramsを更新
          navigation.setParams({
            albumMediaKey: matchingAlbum.mediaKey,
          });
        } else {
          addDebugLog('INIT', `No matching album found for: ${albumTitle}`);
          const albumTitles = parsed.items.map(a => a.title).join(', ');
          addDebugLog('INIT', `Available albums: ${albumTitles}`);
          setIsLoading(false);
          // apiAlbumIdがある場合（作成直後等）はエラー表示しない（WebViewに反映待ち）
          if (!apiAlbumId) {
            setError(`アルバム「${albumTitle}」が見つかりません`);
          }
        }
      } catch (err) {
        addDebugLog('INIT', `Error finding mediaKey: ${err.message}`);
        setIsLoading(false);
        setError(err.message);
      } finally {
        findingMediaKeyRef.current = false;
      }
    };
    
    findMediaKeyForAlbum();
  }, [albumMediaKey, albumTitle, isWebViewReady, sessionData]);

  // WebViewの準備ができたら写真を読み込む（apiAlbumIdがあればGoogle Photos API、なければWebView経由）
  const loadPhotosRef = useRef(null);  // 現在読み込み中のアルバムKey
  useEffect(() => {
    // アルバム初期化が完了するまで待つ
    if (!isAlbumInitialized) {
      console.log('🔍 Waiting for album initialization...');
      return;
    }
    
    console.log('🔍 Check load conditions:', { isWebViewReady, hasSessionData: !!sessionData, albumMediaKey, apiAlbumId, isLoading, loadingAlbum: loadPhotosRef.current });

    // まずGoogle Photos APIから取得を試みる
    const loadFromGooglePhotosApi = async () => {
      try {
        const savedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
        const album = savedAlbum ? JSON.parse(savedAlbum) : null;

        // route.paramsのapiAlbumIdを優先、なければAsyncStorageから取得
        const albumId = apiAlbumId || album?.apiAlbumId;

        addDebugLog('INIT', 'Checking apiAlbumId', {
          fromParams: apiAlbumId || 'null',
          fromStorage: album?.apiAlbumId || 'null',
          using: albumId || 'null'
        });

        // apiAlbumIdがあれば、Google Photos APIから取得
        if (albumId) {
          const auth = await getStoredAuth();
          if (auth?.accessToken) {
            addDebugLog('INIT', 'Loading photos from Google Photos API', { albumId });
            const result = await listAlbumPhotos(auth.accessToken, albumId);

            // APIが0件の場合はWebViewにフォールバック
            if (result.mediaItems && result.mediaItems.length > 0) {
              const convertedPhotos = result.mediaItems.map(item => ({
                mediaKey: item.id,
                thumb: item.baseUrl + '=w200-h200-c',
                url: item.baseUrl + '=w1920-h1080',
                fullUrl: item.baseUrl + '=d',
                timestamp: item.mediaMetadata?.creationTime ? new Date(item.mediaMetadata.creationTime).getTime() : Date.now(),
                creationTimestamp: item.mediaMetadata?.creationTime ? new Date(item.mediaMetadata.creationTime).getTime() : Date.now(),
                isVideo: item.mediaMetadata?.video ? true : false,
                resWidth: parseInt(item.mediaMetadata?.width) || 0,
                resHeight: parseInt(item.mediaMetadata?.height) || 0,
              }));
              setPhotos(convertedPhotos);
              const sections = groupPhotosByDate(convertedPhotos);
              setPhotoSections(sections);
              addDebugLog('INIT', `Loaded ${convertedPhotos.length} photos from API`);
              setIsLoading(false);
              return true; // 成功
            }
            // 0件の場合はfalseを返してWebViewにフォールバック
            addDebugLog('INIT', 'API returned 0 items, falling back to WebView');
            return false;
          }
        }
      } catch (err) {
        addDebugLog('INIT', `Error loading from API: ${err.message}`);
      }
      return false; // 失敗
    };

    // Google Photos APIを試す
    loadFromGooglePhotosApi().then(success => {
      if (success) {
        return; // API取得成功、終了
      }

      // apiAlbumIdがない場合、WebView経由で取得
      if (!albumMediaKey) {
        setIsLoading(false);
        return;
      }

      // 既に同じアルバムを読み込み中なら何もしない
      if (loadPhotosRef.current === albumMediaKey) {
        addDebugLog('INIT', 'Already loading this album, skipping');
        return;
      }

      // WebView経由で写真を取得（isLoadingの条件を削除）
      if (isWebViewReady && sessionData) {
        addDebugLog('INIT', 'Starting loadPhotos via WebView');
        console.log('🚀 Starting loadPhotos for album:', albumMediaKey);
        loadPhotosRef.current = albumMediaKey;
        loadPhotos();
      } else {
        addDebugLog('INIT', 'Waiting for WebView', { isWebViewReady, hasSessionData: !!sessionData });
      }
    });
  }, [isAlbumInitialized, isWebViewReady, sessionData, albumMediaKey, apiAlbumId, loadPhotos]);
  
  // アルバムが変わったらリセット
  useEffect(() => {
    return () => {
      loadPhotosRef.current = null;
    };
  }, [albumMediaKey]);

  // 写真読み込みの統一処理（Geminiの提案に従った実装）
  const loadPhotosFromAlbum = useCallback(async () => {
    // WebViewまたはsessionDataが準備できていなければスキップ（Geminiのガードレール）
    if (!isWebViewReady || !sessionData) {
      addDebugLog('LOAD', 'WebView or sessionData not ready, skipping');
      return false;
    }

    // 既に読み込み中なら何もしない
    if (isLoadingPhotos.current) {
      addDebugLog('LOAD', 'Already loading, skipping');
      return false;
    }

    isLoadingPhotos.current = true;
    try {
      addDebugLog('LOAD', '=== Starting photo load ===');

      // 1. AsyncStorageからアルバム情報を取得
      const savedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
      if (!savedAlbum) {
        addDebugLog('LOAD', 'No saved album');
        return false;
      }

      const album = JSON.parse(savedAlbum);
      addDebugLog('LOAD', `Album: ${album.title}`);

      // 2. APP_CREATED_ALBUMSからapiAlbumIdを取得（新しい構造：apiAlbumIdがキー）
      let apiAlbumId = album.apiAlbumId || null;
      try {
        const savedAlbums = await AsyncStorage.getItem('@photov_app_created_albums');
        if (savedAlbums) {
          const appCreatedAlbums = JSON.parse(savedAlbums);
          // 新しい構造：apiAlbumIdをキーにして、titleで検索
          for (const [id, data] of Object.entries(appCreatedAlbums)) {
            if (data.title === album.title || data.originalTitle === album.title) {
              apiAlbumId = id;
              break;
            }
          }
        }
      } catch (e) {}

      addDebugLog('LOAD', `apiAlbumId: ${apiAlbumId || 'null'}`);

      // 3. apiAlbumIdがあればGoogle Photos APIから取得
      if (apiAlbumId) {
        const auth = await getStoredAuth();
        if (auth?.accessToken) {
          addDebugLog('LOAD', 'Fetching from Google Photos API');
          const result = await listAlbumPhotos(auth.accessToken, apiAlbumId);

          if (result.mediaItems) {
            const convertedPhotos = result.mediaItems.map(item => ({
              mediaKey: item.id,
              thumb: item.baseUrl + '=w200-h200-c',
              url: item.baseUrl + '=w1920-h1080',
              fullUrl: item.baseUrl + '=d',
              timestamp: item.mediaMetadata?.creationTime ? new Date(item.mediaMetadata.creationTime).getTime() : Date.now(),
              creationTimestamp: item.mediaMetadata?.creationTime ? new Date(item.mediaMetadata.creationTime).getTime() : Date.now(),
              isVideo: item.mediaMetadata?.video ? true : false,
              resWidth: parseInt(item.mediaMetadata?.width) || 0,
              resHeight: parseInt(item.mediaMetadata?.height) || 0,
            }));
            // 楽観的更新中は上書きしない（アップロード直後はAPIに反映されていない）
            if (hasOptimisticUpdate.current) {
              addDebugLog('LOAD', `Optimistic update active, preserving photos (API returned ${convertedPhotos.length})`);
              setIsLoading(false);
              return true;
            }
            setPhotos(convertedPhotos);
            const sections = groupPhotosByDate(convertedPhotos);
            setPhotoSections(sections);
            setIsLoading(false);
            addDebugLog('LOAD', `SUCCESS: ${convertedPhotos.length} photos from API`);
            return true;
          }
        }
      }

      // 4. WebView経由で取得
      if (album.mediaKey) {
        addDebugLog('LOAD', 'Fetching via WebView');
        loadPhotosRef.current = null;
        await loadPhotos();
        addDebugLog('LOAD', `SUCCESS: Photos loaded via WebView`);
        return true;
      } else {
        addDebugLog('LOAD', 'No mediaKey available');
        return false;
      }
    } catch (err) {
      addDebugLog('LOAD', `ERROR: ${err.message}`);
      console.error('Load photos error:', err);
      return false;
    } finally {
      isLoadingPhotos.current = false;
    }
  }, [isWebViewReady, sessionData, loadPhotos]);


  // シンプル化：条件が揃ったら写真を読み込む
  useEffect(() => {
    if (isFocused && isWebViewReady && sessionData && route.params?.albumMediaKey && !isLoadingPhotos.current) {
      console.log('[AUTO_LOAD] ✅ All conditions met, loading photos');
      isLoadingPhotos.current = true;
      loadPhotosFromAlbum().finally(() => {
        isLoadingPhotos.current = false;
      });
    }
  }, [isFocused, isWebViewReady, sessionData, route.params?.albumMediaKey, loadPhotosFromAlbum]);

  /**
   * APIリクエストを実行
   */
  const executeApiRequest = useCallback(async (script, requestId) => {
    if (!webViewRef.current || !isWebViewReady) {
      throw new Error('WebViewが準備できていません');
    }

    console.log('📤 Executing API request:', requestId);

    // Gemini推奨：Mapで管理
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log('⏰ Request timeout:', requestId);
        if (pendingRequests.current.has(requestId)) {
          pendingRequests.current.delete(requestId);
        }
        reject(new Error(`リクエストタイムアウト: ${requestId}`));
      }, 30000);

      // requestIdをキーにして保存
      pendingRequests.current.set(requestId, {
        resolve: (data) => {
          console.log('✅ Request success:', requestId);
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (error) => {
          console.log('❌ Request error:', requestId, error);
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    webViewRef.current.injectJavaScript(script);
    return promise;
  }, [isWebViewReady]);

  /**
   * アルバム内の全写真を取得（自動ページネーション）
   */
  const getAllAlbumItems = useCallback(async (mediaKey, ak, onProgress) => {
    const allItems = [];
    let pageId = null;
    let totalCount = 0;

    do {
      const requestId = generateRequestId();
      const script = generateGetAlbumPageScript(requestId, sessionData, mediaKey, pageId, ak);
      const data = await executeApiRequest(script, requestId);
      const page = parseAlbumItemsResponse(data);

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
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } while (pageId);

    return allItems;
  }, [sessionData, executeApiRequest]);

  const loadPhotos = useCallback(async () => {
    // アルバムキーがない場合は何もしない（useEffectで読み込み中）
    if (!albumMediaKey) {
      console.log('⏸️ loadPhotos: No albumMediaKey, waiting...');
      addDebugLog('LOAD', 'No albumMediaKey, skipping');
      return;
    }

    if (!sessionData) {
      console.log('⏸️ loadPhotos: No sessionData, waiting...');
      addDebugLog('LOAD', 'No sessionData, skipping');
      return;
    }

    addDebugLog('LOAD', 'Starting loadPhotos', { albumMediaKey, authKey });
    const currentAlbumMediaKey = albumMediaKey;
    const currentAuthKey = authKey;

    try {
      setError(null);
      setLoadProgress({ loaded: 0, total: 0 });

      addDebugLog('LOAD', 'Calling getAllAlbumItems');
      const items = await getAllAlbumItems(
        currentAlbumMediaKey,
        currentAuthKey,
        (loaded, total) => {
          setLoadProgress({ loaded, total });
        }
      );

      addDebugLog('LOAD', `getAllAlbumItems returned ${items.length} items`);

      // 日付順にソート（新しい順）
      const sortedItems = [...items].sort((a, b) => {
        const tsA = a.timestamp || a.creationTimestamp || 0;
        const tsB = b.timestamp || b.creationTimestamp || 0;
        return tsB - tsA;
      });

      // Gemini推奨：AsyncStorageからAPI IDマッピングを復元
      try {
        let restoredCount = 0;
        for (const photo of sortedItems) {
          const key = `@photov_api_id_${photo.mediaKey}`;
          const savedApiId = await AsyncStorage.getItem(key);
          if (savedApiId) {
            photo.apiMediaItemId = savedApiId;
            restoredCount++;
            addDebugLog('LOAD', `Restored: ${key.substring(0, 30)}... -> ${savedApiId.substring(0, 20)}...`);
          } else {
            addDebugLog('LOAD', `Not found: ${key.substring(0, 50)}...`);
          }
        }
        addDebugLog('LOAD', `Restored ${restoredCount} API IDs from AsyncStorage`);
      } catch (error) {
        addDebugLog('LOAD', `Failed to restore API IDs: ${error.message}`);
      }

      // 楽観的更新中は上書きしない（アップロード直後の反映待ち）
      if (hasOptimisticUpdate.current) {
        addDebugLog('LOAD', `Optimistic update active, preserving photos (WebView returned ${sortedItems.length})`);
      } else {
        setPhotos(sortedItems);
        const sections = groupPhotosByDate(sortedItems);
        setPhotoSections(sections);
      }

      // デバッグ：最初の写真のdedupKeyを確認
      if (sortedItems.length > 0) {
        addDebugLog('LOAD', `First photo dedupKey check`, {
          mediaKey: sortedItems[0].mediaKey?.substring(0, 20),
          dedupKey: sortedItems[0].dedupKey?.substring(0, 20),
          hasDedupKey: !!sortedItems[0].dedupKey
        });
      }

      addDebugLog('LOAD', `Loaded ${sortedItems.length} photos successfully`);
    } catch (err) {
      console.error('写真読み込みエラー:', err);
      addDebugLog('LOAD', `Error: ${err.message}`);
      setError(err.message);

      if (err.message.includes('セッション')) {
        Alert.alert(
          'セッション切れ',
          '再度ログインが必要です',
          [{ text: 'OK', onPress: () => navigation.replace('WebAuth') }]
        );
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [albumMediaKey, authKey, sessionData, getAllAlbumItems]);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    addDebugLog('REFRESH', 'onRefresh called');

    try {
      // AsyncStorageから最新のapiAlbumIdを取得
      const savedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
      const album = savedAlbum ? JSON.parse(savedAlbum) : null;
      addDebugLog('REFRESH', 'Album data', { apiAlbumId: album?.apiAlbumId || 'null' });

      // apiAlbumIdがあれば、Google Photos APIから取得
      if (album?.apiAlbumId) {
        const auth = await getStoredAuth();
        if (auth?.accessToken) {
          addDebugLog('REFRESH', 'Fetching from Google Photos API');
          const result = await listAlbumPhotos(auth.accessToken, album.apiAlbumId);

          if (result.mediaItems) {
            const convertedPhotos = result.mediaItems.map(item => ({
              mediaKey: item.id,
              thumb: item.baseUrl + '=w200-h200-c',
              url: item.baseUrl + '=w1920-h1080',
              fullUrl: item.baseUrl + '=d',
              timestamp: item.mediaMetadata?.creationTime ? new Date(item.mediaMetadata.creationTime).getTime() : Date.now(),
              creationTimestamp: item.mediaMetadata?.creationTime ? new Date(item.mediaMetadata.creationTime).getTime() : Date.now(),
              isVideo: item.mediaMetadata?.video ? true : false,
              resWidth: parseInt(item.mediaMetadata?.width) || 0,
              resHeight: parseInt(item.mediaMetadata?.height) || 0,
            }));
            // リフレッシュ時はhasOptimisticUpdateをクリアして最新データを表示
            hasOptimisticUpdate.current = false;
            setPhotos(convertedPhotos);
            const sections = groupPhotosByDate(convertedPhotos);
            setPhotoSections(sections);
            addDebugLog('REFRESH', `Loaded ${convertedPhotos.length} photos from API`);
            setIsRefreshing(false);
            return;
          }
        }
      }

      // apiAlbumIdがない場合、WebView経由で取得を試みる
      if (albumMediaKey && sessionData) {
        addDebugLog('REFRESH', 'Falling back to WebView');

        // WebViewの準備完了を待つ（最大8秒）
        let retries = 0;
        while (!isWebViewReady && retries < 80) {
          await new Promise(resolve => setTimeout(resolve, 100));
          retries++;
        }

        if (isWebViewReady) {
          try {
            // loadPhotosRefをクリアして、再読み込みを許可
            loadPhotosRef.current = null;
            await loadPhotos();
          } catch (err) {
            // WebViewエラーの場合は無視（次の自動読み込みで取得される）
            if (err.message?.includes('WebView')) {
              addDebugLog('REFRESH', 'WebView not ready, will retry automatically');
            } else {
              throw err;
            }
          }
        } else {
          addDebugLog('REFRESH', 'WebView did not become ready in time');
        }
      } else {
        addDebugLog('REFRESH', 'No albumMediaKey or WebView not ready, skipping', {
          hasAlbumMediaKey: !!albumMediaKey,
          isWebViewReady,
          hasSessionData: !!sessionData
        });
      }
      setIsRefreshing(false);
    } catch (err) {
      console.error('Refresh error:', err);
      addDebugLog('REFRESH', `Error: ${err.message}`);
      if (err.message?.includes('WebView')) {
        setError('接続エラー。下に引っ張って再試行してください。');
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [loadPhotos, isWebViewReady, albumMediaKey, sessionData]);

  const openPhotoDetail = useCallback((photo) => {
    // 全写真をフラット化
    const allPhotos = photoSections.flatMap(section => section.data);
    // 現在の写真のインデックスを検索
    const initialIndex = allPhotos.findIndex(p => p.mediaKey === photo.mediaKey);
    navigation.navigate('PhotoDetailWeb', {
      photo,
      photos: allPhotos,
      initialIndex: initialIndex >= 0 ? initialIndex : 0,
      fullSizeUrl: getFullSizeUrl(photo.thumb),
    });
  }, [navigation, photoSections]);

  // アップロード処理
  const [isUploading, setIsUploading] = useState(false);
  
  // Google認証レスポンスを監視
  useEffect(() => {
    if (googleResponse?.type === 'success' && pendingUploadAssets) {
      handleAuthResponse(googleResponse).then(authData => {
        if (authData) {
          performUpload(pendingUploadAssets, authData.accessToken);
        }
        setPendingUploadAssets(null);
      });
    }
  }, [googleResponse, pendingUploadAssets]);

  const handleUpload = useCallback(async () => {
    try {
      // 権限リクエスト
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          '権限が必要',
          '写真へのアクセス権限を許可してください',
          [
            { text: 'キャンセル', style: 'cancel' },
            { text: '設定を開く', onPress: () => Linking.openSettings() },
          ]
        );
        return;
      }

      // 画像/動画を選択（EXIF情報を取得）
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        quality: 1,
        exif: true, // EXIF情報を取得（撮影日時など）
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      // デバッグ：選択された画像の情報を確認
      addDebugLog('UPLOAD', `Selected ${result.assets.length} assets`);
      addDebugLog('UPLOAD', `First asset:`, JSON.stringify(result.assets[0]));

      // EXIF書き込み処理（iOSがファイルコピー時にEXIFを消すことがあるため）
      const processedAssets = [];
      for (const asset of result.assets) {
        try {
          // 動画はEXIF書き込みスキップ
          if (asset.type === 'video' || asset.mimeType?.startsWith('video/')) {
            processedAssets.push(asset);
            continue;
          }

          // EXIF情報があれば書き込み
          if (asset.exif && (asset.exif.DateTimeOriginal || asset.exif.DateTime)) {
            addDebugLog('UPLOAD', `Writing EXIF to ${asset.uri.substring(0, 50)}...`);
            addDebugLog('UPLOAD', `EXIF data:`, JSON.stringify(asset.exif).substring(0, 200));
            
            try {
              const { Exify } = require('@lodev09/react-native-exify');
              await Exify.write(asset.uri, {
                DateTimeOriginal: asset.exif.DateTimeOriginal,
                DateTime: asset.exif.DateTime || asset.exif.DateTimeOriginal,
              });
              addDebugLog('UPLOAD', `EXIF written successfully`);
            } catch (exifyError) {
              addDebugLog('UPLOAD', `EXIF write failed (continuing): ${exifyError.message}`);
              // EXIF書き込み失敗しても続行
            }
          } else {
            addDebugLog('UPLOAD', `No EXIF data for asset, skipping EXIF write`);
          }
          processedAssets.push(asset);
        } catch (assetError) {
          addDebugLog('UPLOAD', `Asset processing error: ${assetError.message}`);
          processedAssets.push(asset); // エラーでも続行
        }
      }

      // OAuth 2.0認証を確認
      let auth = await getStoredAuth();
      if (!auth?.accessToken) {
        // 認証がない場合、認証画面を開く
        addDebugLog('UPLOAD', 'No auth token, prompting Google OAuth');
        setPendingUploadAssets(processedAssets);
        promptGoogleAsync();
        return;
      }

      // OAuth 2.0経由でアップロード実行
      await performUpload(processedAssets, auth.accessToken);
    } catch (error) {
      console.error('Upload error:', error);
      Alert.alert('エラー', 'アップロードに失敗しました');
    }
  }, [promptGoogleAsync, performUpload]);

  // Gemini推奨：アップロード後にdedupKeyを取得してマッチング
  const fetchDedupKeysForUploadedPhotos = useCallback(async (uploadedPhotos) => {
    if (!uploadedPhotos || uploadedPhotos.length === 0) return;

    try {
      addDebugLog('DEDUP', `Fetching dedupKeys for ${uploadedPhotos.length} uploaded photos`);

      // アルバム情報を取得
      const savedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
      const album = savedAlbum ? JSON.parse(savedAlbum) : null;

      if (!album?.mediaKey) {
        addDebugLog('DEDUP', 'No albumMediaKey, skipping dedupKey fetch');
        return;
      }

      const currentAlbumMediaKey = album.mediaKey;
      const currentAuthKey = album.authKey || null;

      // 非公式APIで写真リストを再取得（sessionDataチェックは削除、APIエラー時はcatchで処理）
      const items = await getAllAlbumItems(currentAlbumMediaKey, currentAuthKey);
      addDebugLog('DEDUP', `Got ${items.length} items from non-official API`);

      // アップロードした写真とマッチング（タイムスタンプ + サイズ）
      let matchedCount = 0;
      for (const uploaded of uploadedPhotos) {
        const matched = items.find(webPhoto => {
          const timeDiff = Math.abs(uploaded.timestamp - webPhoto.timestamp);
          const sizeMatch =
            uploaded.resWidth === webPhoto.resWidth &&
            uploaded.resHeight === webPhoto.resHeight;

          return timeDiff < 5000 && sizeMatch; // 5秒以内、サイズ一致
        });

        if (matched?.dedupKey) {
          // dedupKeyを更新
          uploaded.dedupKey = matched.dedupKey;
          uploaded.mediaKey = matched.mediaKey; // WebView IDに更新
          matchedCount++;

          addDebugLog('DEDUP', `Matched photo`, {
            apiId: uploaded.apiMediaItemId?.substring(0, 15),
            dedupKey: matched.dedupKey?.substring(0, 15),
            mediaKey: matched.mediaKey?.substring(0, 15)
          });
        }
      }

      addDebugLog('DEDUP', `Matched ${matchedCount}/${uploadedPhotos.length} photos with dedupKeys`);

      // 状態を更新（dedupKey付きの写真に置き換え）
      setPhotos(prev => {
        // アップロードした写真を除外
        const filtered = prev.filter(p =>
          !uploadedPhotos.find(u => u.apiMediaItemId === p.apiMediaItemId)
        );
        // dedupKey付きの写真を先頭に追加
        return [...uploadedPhotos, ...filtered];
      });
      setPhotoSections(prev => groupPhotosByDate(photos));

      addDebugLog('DEDUP', 'Updated photos state with dedupKeys');
    } catch (error) {
      addDebugLog('DEDUP', `Failed to fetch dedupKeys: ${error.message}`);
    }
  }, [sessionData, albumMediaKey, authKey, getAllAlbumItems, photos]);

  // ⚠️ 削除禁止：アップロード後のポーリング機能（2026-02-12実装、コミット1a068ac）
  // Gemini推奨：1秒ごとにポーリング、最大10回、進捗表示（X/10）
  // アップロード後の写真同期を確実にするための重要な機能
  // 変更する場合は必ずgit履歴を確認し、ユーザーに確認すること
  const pollForNewPhotos = useCallback(async (initialPhotoCount, uploadedPhotos = []) => {
    shouldStopPolling.current = false; // ポーリング開始時にフラグをリセット
    setIsPollingForUpload(true);
    setPollingAttempts(0);
    addDebugLog('POLLING', `Starting polling for new photos. Initial count: ${initialPhotoCount}`);

    let attempts = 0;
    const poll = async () => {
      // ポーリングが停止された場合は終了
      if (shouldStopPolling.current) {
        addDebugLog('POLLING', 'Polling stopped by external trigger.');
        return;
      }

      // 最大試行回数に達したら終了
      if (attempts >= MAX_POLLING_ATTEMPTS) {
        addDebugLog('POLLING', 'Max polling attempts reached.');
        shouldStopPolling.current = true;
        setIsPollingForUpload(false);

        // Gemini推奨：ポーリング完了後、dedupKeyを取得
        if (uploadedPhotos.length > 0) {
          await fetchDedupKeysForUploadedPhotos(uploadedPhotos);
        }

        Alert.alert(
          '情報',
          '写真の同期に時間がかかっています。しばらくしてから手動でリフレッシュしてください。'
        );
        return;
      }

      attempts++;
      setPollingAttempts(attempts);
      addDebugLog('POLLING', `Polling attempt ${attempts}/${MAX_POLLING_ATTEMPTS}`);

      try {
        // リフレッシュを実行
        await onRefresh();

        // 注意：onRefresh()は非同期だが、photos stateの更新は即座に反映されない
        // そのため、次のsetTimeoutで再度チェック
        // より確実にするには、onRefresh内でphotos.lengthを返すように修正する必要がある
      } catch (error) {
        addDebugLog('POLLING', `Error during polling: ${error.message}`);
      }

      // 次のポーリングをスケジュール（写真が見つかるまで続ける）
      pollingTimerRef.current = setTimeout(poll, POLLING_INTERVAL);
    };

    // 最初のポーリングを開始
    setTimeout(poll, POLLING_INTERVAL);
  }, [onRefresh, fetchDedupKeysForUploadedPhotos]);

  // ポーリング中に写真が増えたか監視
  useEffect(() => {
    if (isPollingForUpload && photos.length > 0) {
      // 写真が見つかった！ポーリング終了
      addDebugLog('POLLING', `New photos found! Current count: ${photos.length}`);
      shouldStopPolling.current = true; // 停止フラグを設定
      setIsPollingForUpload(false);
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
      }
    }
  }, [isPollingForUpload, photos.length]);

  // 画面フォーカス時の処理：画面から離れる時にポーリングを停止
  useFocusEffect(
    useCallback(() => {
      // 画面にフォーカスが当たった時（何もしない）

      return () => {
        // 画面からフォーカスが外れた時：ポーリングを停止
        shouldStopPolling.current = true;
        if (pollingTimerRef.current) {
          clearTimeout(pollingTimerRef.current);
        }
        setIsPollingForUpload(false);
      };
    }, [])
  );

  // クリーンアップ：コンポーネントアンマウント時
  useEffect(() => {
    return () => {
      // ポーリングを停止
      shouldStopPolling.current = true;
      if (pollingTimerRef.current) {
        clearTimeout(pollingTimerRef.current);
      }
      setIsPollingForUpload(false);
    };
  }, []);

  const performUpload = useCallback(async (assets, accessToken) => {
    setIsUploading(true);
    addDebugLog('UPLOAD', `Starting upload of ${assets.length} files to album: ${albumTitle}`);

    try {
      let successCount = 0;
      let errorMessages = [];
      const uploadedPhotos = [];

      for (const asset of assets) {
        try {
          // PhotoVで作成したアルバムの場合はapiAlbumIdを使用
          // それ以外はライブラリにアップロード
          addDebugLog('UPLOAD', `Using apiAlbumId: ${apiAlbumId || 'null (library)'}`);
          const result = await uploadToGooglePhotos(
            accessToken,
            asset.uri,
            asset.mimeType || 'image/jpeg',
            apiAlbumId // PhotoV作成アルバムの場合のみアルバムに追加
          );

          if (result?.newMediaItemResults?.[0]?.status?.message === 'Success') {
            successCount++;
            addDebugLog('UPLOAD', `File ${successCount} uploaded successfully`);
            
            // アップロード成功したmediaItemを保存
            const mediaItem = result.newMediaItemResults[0].mediaItem;
            if (mediaItem) {
              uploadedPhotos.push({
                mediaKey: mediaItem.id,
                // baseUrlが未定義の場合、ローカルURIをthumbとして使用（楽観的表示）
                thumb: mediaItem.baseUrl ? (mediaItem.baseUrl + '=w200-h200-c') : asset.uri,
                url: mediaItem.baseUrl ? (mediaItem.baseUrl + '=w1920-h1080') : asset.uri,
                fullUrl: mediaItem.baseUrl ? (mediaItem.baseUrl + '=d') : asset.uri,
                timestamp: mediaItem.mediaMetadata?.creationTime ? new Date(mediaItem.mediaMetadata.creationTime).getTime() : Date.now(),
                creationTimestamp: mediaItem.mediaMetadata?.creationTime ? new Date(mediaItem.mediaMetadata.creationTime).getTime() : Date.now(),
                isVideo: mediaItem.mimeType?.startsWith('video/') || false,
                resWidth: parseInt(mediaItem.mediaMetadata?.width) || 0,
                resHeight: parseInt(mediaItem.mediaMetadata?.height) || 0,
                apiMediaItemId: mediaItem.id,
              });
              // AsyncStorageに保存（削除機能で使用）
              await AsyncStorage.setItem(`@photov_api_id_${mediaItem.id}`, mediaItem.id);
              addDebugLog('UPLOAD', `Saved API ID mapping: ${mediaItem.id}`);
            }
          } else {
            const status = result?.newMediaItemResults?.[0]?.status;
            addDebugLog('UPLOAD', `File upload status: ${JSON.stringify(status)}`);
            if (status?.message !== 'Success') {
              errorMessages.push(status?.message || 'Unknown error');
            }
          }
        } catch (error) {
          console.error('Upload single file error:', error);
          addDebugLog('UPLOAD', `File upload error: ${error.message}`);
          errorMessages.push(error.message);
        }
      }

      // Gemini推奨：アップロード成功した写真を即座に表示（API ID付き）
      if (uploadedPhotos.length > 0) {
        hasOptimisticUpdate.current = true; // 楽観的更新フラグをセット（0件での上書き防止）
        // 関数形式で最新のphotos状態を参照（クロージャの古い値を使わない）
        setPhotos(prevPhotos => {
          const updatedPhotos = [...uploadedPhotos, ...prevPhotos];
          const newSections = groupPhotosByDate(updatedPhotos);
          setPhotoSections(newSections);
          addDebugLog('UPLOAD', `Added ${uploadedPhotos.length} photos with API ID to view immediately (prev had ${prevPhotos.length} photos)`);
          return updatedPhotos;
        });

        // Gemini推奨：AsyncStorageにAPI IDマッピングを保存（dedupKeyで紐付け）
        try {
          const savedKeys = await AsyncStorage.getItem('@photov_uploaded_ids') || '{}';
          const uploadedIds = JSON.parse(savedKeys);

          for (const photo of uploadedPhotos) {
            // 公式API IDを保存（後でdedupKeyで検索）
            uploadedIds[photo.apiMediaItemId] = {
              apiId: photo.apiMediaItemId,
              uploadedAt: Date.now()
            };
          }

          await AsyncStorage.setItem('@photov_uploaded_ids', JSON.stringify(uploadedIds));
          addDebugLog('UPLOAD', `Saved ${uploadedPhotos.length} API IDs to registry`);
        } catch (error) {
          addDebugLog('UPLOAD', `Failed to save API IDs: ${error.message}`);
        }
      }

      // 結果を表示
      let message = `${successCount}/${assets.length} 件をアップロードしました`;
      if (errorMessages.length > 0) {
        message += `\n\nエラー: ${errorMessages.slice(0, 3).join(', ')}`;
      }

      // アップロード結果を表示（楽観的更新済みなのでnavigation.replaceは不要）
      if (successCount > 0) {
        addDebugLog('UPLOAD', `Upload completed: ${successCount} photos (already shown via optimistic update)`);
        Alert.alert('アップロード完了', message);
      } else {
        Alert.alert('アップロード失敗', message);
      }
    } catch (error) {
      addDebugLog('UPLOAD', `Upload batch error: ${error.message}`);
      Alert.alert('エラー', 'アップロードに失敗しました\n\n' + error.message);
    } finally {
      setIsUploading(false);
    }
  }, [albumTitle, apiAlbumId]); // photosは関数形式で参照するため依存不要

  // 写真をダウンロード（カメラロールに保存）
  const downloadPhoto = useCallback(async (photo) => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('エラー', '写真へのアクセス許可が必要です');
        return false;
      }
      
      // 高解像度URLを取得
      const photoUrl = photo.url || `https://lh3.googleusercontent.com/${photo.mediaKey}=w2048-h2048`;
      const filename = `photov_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
      const fileUri = FileSystem.documentDirectory + filename;
      
      // ダウンロード
      const downloadResult = await FileSystem.downloadAsync(photoUrl, fileUri);
      
      // カメラロールに保存
      const asset = await MediaLibrary.createAssetAsync(downloadResult.uri);
      
      // 一時ファイルを削除
      await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true });
      
      return true;
    } catch (error) {
      console.error('Download error:', error);
      addDebugLog('DOWNLOAD', `Error: ${error.message}`);
      return false;
    }
  }, []);

  // 選択した写真をダウンロード
  const downloadSelectedPhotos = useCallback(async () => {
    if (selectedPhotos.size === 0) return;
    
    setIsDownloading(true);
    let successCount = 0;
    
    for (const photoKey of selectedPhotos) {
      const photo = photos.find(p => p.mediaKey === photoKey);
      if (photo) {
        const success = await downloadPhoto(photo);
        if (success) successCount++;
      }
    }
    
    setIsDownloading(false);
    setSelectionMode(false);
    setSelectedPhotos(new Set());
    
    Alert.alert(
      'ダウンロード完了',
      `${successCount}枚の写真をカメラロールに保存しました`
    );
  }, [selectedPhotos, photos, downloadPhoto]);

  // Gemini推奨：非公式API削除処理（認証不要）
  const performDelete = useCallback(async (deleteData) => {
    setIsDeleting(true);
    addDebugLog('DELETE', `Starting delete of ${deleteData.selectedMediaKeys.length} photos`);

    try {
      const { selectedMediaKeys, allPhotos } = deleteData;

      // Gemini推奨：選択されたmediaKeyから写真オブジェクトを取得し、dedupKeyを抽出
      const selectedPhotoObjects = selectedMediaKeys
        .map(mediaKey => allPhotos.find(p => p.mediaKey === mediaKey))
        .filter(Boolean);

      addDebugLog('DELETE', `Found ${selectedPhotoObjects.length} photo objects`);

      // dedupKeyを持つ写真と持たない写真を分類
      const photosWithDedupKey = selectedPhotoObjects.filter(p => p.dedupKey);
      const photosWithoutDedupKey = selectedPhotoObjects.filter(p => !p.dedupKey);

      addDebugLog('DELETE', `Photos with dedupKey: ${photosWithDedupKey.length}, without: ${photosWithoutDedupKey.length}`);

      // dedupKeyなし・apiMediaItemIdありの写真（楽観的更新で追加）→ アルバムから除外
      const photosRemovableByApi = photosWithoutDedupKey.filter(p => p.apiMediaItemId);
      if (photosWithDedupKey.length === 0 && photosRemovableByApi.length === 0) {
        Alert.alert(
          '削除できません',
          '選択された写真を削除できませんでした。\n\n画面を更新してから再度お試しください。'
        );
        setIsDeleting(false);
        return;
      }

      const dedupKeys = photosWithDedupKey.map(p => p.dedupKey);

      addDebugLog('DELETE', `Removing ${dedupKeys.length} photos via non-official API, ${photosRemovableByApi.length} via official API`, {
        dedupKeys: dedupKeys.slice(0, 3)
      });

      try {
        // 非公式APIで削除（dedupKeyあり）
        if (dedupKeys.length > 0) {
          console.log('🗑️ Calling moveItemsToTrash with', dedupKeys.length, 'keys');
          if (dedupKeys.length <= 50) {
            await moveItemsToTrash(dedupKeys);
          } else {
            await moveItemsToTrashBatch(dedupKeys, (processed, total) => {
              addDebugLog('DELETE', `Progress: ${processed}/${total}`);
            });
          }
          addDebugLog('DELETE', 'Photos moved to trash successfully');
          console.log('🗑️ moveItemsToTrash completed successfully');
        } else {
          console.log('⚠️ No dedupKeys to delete!');
        }

        // 公式APIでアルバムから除外（楽観的更新写真・dedupKeyなし・apiMediaItemIdあり）
        if (photosRemovableByApi.length > 0 && apiAlbumId) {
          const auth = await getStoredAuth();
          if (auth?.accessToken) {
            const mediaItemIds = photosRemovableByApi.map(p => p.apiMediaItemId);
            await removePhotosFromAlbum(auth.accessToken, apiAlbumId, mediaItemIds);
            addDebugLog('DELETE', `Removed ${mediaItemIds.length} optimistic photos from album via official API`);
          }
        }

        // 削除成功後、即座にstateから削除（UX改善）
        const deletedMediaKeys = [
          ...photosWithDedupKey.map(p => p.mediaKey),
          ...photosRemovableByApi.map(p => p.mediaKey),
        ];
        const updatedPhotos = allPhotos.filter(p => !deletedMediaKeys.includes(p.mediaKey));
        setPhotos(updatedPhotos);
        const updatedSections = groupPhotosByDate(updatedPhotos);
        setPhotoSections(updatedSections);
        addDebugLog('DELETE', `Removed ${deletedMediaKeys.length} photos from state immediately`);

        // AsyncStorageから削除された写真のAPI IDを削除
        const apiIdsToRemove = [...photosWithDedupKey, ...photosRemovableByApi]
          .filter(p => p.apiMediaItemId)
          .map(p => `@photov_api_id_${p.mediaKey}`);

        if (apiIdsToRemove.length > 0) {
          try {
            await AsyncStorage.multiRemove(apiIdsToRemove);
            addDebugLog('DELETE', `Removed ${apiIdsToRemove.length} API IDs from AsyncStorage`);
          } catch (storageError) {
            addDebugLog('DELETE', `Failed to remove API IDs from AsyncStorage: ${storageError.message}`);
          }
        }
      } catch (deleteError) {
        addDebugLog('DELETE', 'Delete error', {
          error: deleteError.message,
          dedupKeyCount: dedupKeys.length
        });
        throw deleteError;
      }

      setIsDeleting(false);
      setSelectionMode(false);
      setSelectedPhotos(new Set());

      // Gemini推奨：削除後は即座にstateを更新済みなので、リフレッシュは不要
      // バックグラウンドでリフレッシュすると無限ループの原因になる
      // setTimeout(() => onRefresh(), 500);

      const totalDeleted = dedupKeys.length + photosRemovableByApi.length;
      let successMsg = `${totalDeleted}枚の写真を削除しました`;
      if (dedupKeys.length > 0) {
        successMsg += `\n（${dedupKeys.length}枚はゴミ箱へ移動、30日間は復元できます）`;
      }
      Alert.alert('削除完了', successMsg);
    } catch (error) {
      addDebugLog('DELETE', `Error: ${error.message}`);
      Alert.alert('エラー', `削除に失敗しました\n\n${error.message}`);
      setIsDeleting(false);
    }
  }, [onRefresh, photos]);

  // 選択した写真を削除（ゴミ箱に移動）
  const deleteSelectedPhotos = useCallback(async () => {
    if (selectedPhotos.size === 0) return;

    // 確認ダイアログ
    Alert.alert(
      '写真を削除',
      `${selectedPhotos.size}枚の写真をゴミ箱に移動しますか？\n\n※ 30日間はゴミ箱から復元できます`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
          style: 'destructive',
          onPress: async () => {
            // Gemini推奨：非公式APIなので認証不要、直接削除処理を実行
            await performDelete({
              selectedMediaKeys: Array.from(selectedPhotos),
              allPhotos: photos
            });
          },
        },
      ]
    );
  }, [selectedPhotos, photos, performDelete]);

  // 写真の選択トグル
  const togglePhotoSelection = useCallback((mediaKey) => {
    setSelectedPhotos(prev => {
      const newSet = new Set(prev);
      if (newSet.has(mediaKey)) {
        newSet.delete(mediaKey);
      } else {
        newSet.add(mediaKey);
      }
      return newSet;
    });
  }, []);

  // 選択モードを終了
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedPhotos(new Set());
  }, []);

  // カバー写真を設定
  const handleSelectCoverPhoto = useCallback(async (photo) => {
    if (!apiAlbumId) {
      Alert.alert('エラー', 'PhotoVで作成したアルバムのみカバー写真を設定できます');
      return;
    }

    // apiMediaItemIdが必要
    if (!photo.apiMediaItemId) {
      Alert.alert('エラー', 'このアプリでアップロードした写真のみカバー写真に設定できます\n\n※ 他の写真をカバーにしたい場合は、一度削除してから再度アップロードしてください');
      return;
    }

    try {
      const auth = await getStoredAuth();
      if (!auth || !auth.accessToken) {
        Alert.alert('エラー', '認証が必要です');
        return;
      }

      await setCoverPhoto(auth.accessToken, apiAlbumId, photo.apiMediaItemId);
      Alert.alert('成功', 'カバー写真を設定しました', [
        {
          text: 'OK',
          onPress: () => {
            // アルバム一覧に戻る
            navigation.goBack();
          }
        }
      ]);
    } catch (error) {
      console.error('Set cover photo error:', error);
      Alert.alert('エラー', `カバー写真の設定に失敗しました\n\n${error.message}`);
    }
  }, [apiAlbumId, navigation]);

  // アルバム操作メニュー（タイトル長押し）
  const handleRenameAlbum = useCallback(() => {
    if (!apiAlbumId) {
      // apiAlbumIdがないアルバムは操作不可
      return;
    }

    Alert.alert(
      albumTitle,
      'アルバム操作',
      [
        {
          text: 'アルバムをリネーム',
          onPress: () => {
            setNewAlbumTitle(albumTitle);
            setShowRenameDialog(true);
          },
        },
        {
          text: 'アルバムを削除',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'アルバムを削除',
              `「${albumTitle}」を削除しますか？\n\nアルバム内の写真はライブラリに残ります。`,
              [
                { text: 'キャンセル', style: 'cancel' },
                {
                  text: '削除',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      addDebugLog('DELETE_ALBUM', `Deleting album: ${apiAlbumId}`);
                      await deleteAlbum(apiAlbumId);
                      addDebugLog('DELETE_ALBUM', 'deleteAlbum succeeded');
                      // SELECTED_ALBUMをクリア（APP_CREATED_ALBUMSはAlbumSelectWebScreenで管理）
                      await AsyncStorage.removeItem(STORAGE_KEYS.SELECTED_ALBUM);
                      Alert.alert('削除完了', `「${albumTitle}」を削除しました`, [
                        { text: 'OK', onPress: () => navigation.replace('AlbumSelectWeb') },
                      ]);
                    } catch (error) {
                      addDebugLog('DELETE_ALBUM', `Error: ${error.message}`);
                      Alert.alert('エラー', `削除に失敗しました\n\n${error.message}`);
                    }
                  },
                },
              ]
            );
          },
        },
        {
          text: 'キャンセル',
          style: 'cancel',
        },
      ]
    );
  }, [apiAlbumId, albumTitle, navigation]);

  const performRenameAlbum = useCallback(async () => {
    if (!newAlbumTitle.trim()) {
      Alert.alert('エラー', '新しいアルバム名を入力してください');
      return;
    }

    const trimmedNewTitle = newAlbumTitle.trim();
    if (albumTitle === trimmedNewTitle) {
      setShowRenameDialog(false);
      return;
    }

    setShowRenameDialog(false);
    setIsLoading(true);
    addDebugLog('ALBUM', `Renaming album: ${albumTitle} -> ${trimmedNewTitle}`);

    try {
      // Google認証を取得
      const auth = await getStoredAuth();
      if (!auth || !auth.accessToken) {
        // 認証が必要
        const result = await promptGoogleAsync();
        if (!result) {
          throw new Error('認証が必要です');
        }
        auth.accessToken = result.accessToken;
      }

      // アルバム名を更新
      await updateAlbumTitle(auth.accessToken, apiAlbumId, trimmedNewTitle);
      addDebugLog('ALBUM', `Album renamed successfully: ${trimmedNewTitle}`);

      // AsyncStorageのAPP_CREATED_ALBUMSを更新（新しい構造：apiAlbumIdがキー）
      try {
        const savedAlbums = await AsyncStorage.getItem(STORAGE_KEYS.APP_CREATED_ALBUMS);
        const appCreatedAlbums = savedAlbums ? JSON.parse(savedAlbums) : {};

        // apiAlbumIdをキーにしてtitleを更新
        if (apiAlbumId && appCreatedAlbums[apiAlbumId]) {
          appCreatedAlbums[apiAlbumId].title = trimmedNewTitle;
          await AsyncStorage.setItem(STORAGE_KEYS.APP_CREATED_ALBUMS, JSON.stringify(appCreatedAlbums));
          addDebugLog('ALBUM', `Updated APP_CREATED_ALBUMS title: ${albumTitle} -> ${trimmedNewTitle}`);
        }

        // SELECTED_ALBUMを更新
        const selectedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
        if (selectedAlbum) {
          const selectedData = JSON.parse(selectedAlbum);
          selectedData.title = trimmedNewTitle;
          await AsyncStorage.setItem(STORAGE_KEYS.SELECTED_ALBUM, JSON.stringify(selectedData));
          addDebugLog('ALBUM', 'Updated SELECTED_ALBUM title');
        }

        // 画面のタイトルを更新
        setAlbumInfo(prev => ({ ...prev, title: trimmedNewTitle }));
      } catch (e) {
        addDebugLog('ALBUM', `Failed to update AsyncStorage: ${e.message}`);
      }

      Alert.alert(
        'リネーム完了',
        `「${albumTitle}」を「${trimmedNewTitle}」に変更しました。`
      );
    } catch (error) {
      addDebugLog('ALBUM', `Rename album error: ${error.message}`);
      Alert.alert('エラー', `アルバム名の変更に失敗しました\n\n${error.message}`);
    } finally {
      setIsLoading(false);
      setNewAlbumTitle('');
    }
  }, [newAlbumTitle, albumTitle, apiAlbumId, promptGoogleAsync]);

  const changeAlbum = useCallback(async () => {
    await AsyncStorage.removeItem(STORAGE_KEYS.SELECTED_ALBUM);
    navigation.replace('AlbumSelectWeb');
  }, [navigation]);

  const openDebugMenu = useCallback(async () => {
    const logs = await getDebugLogs();
    setDebugLogs(logs);
    setShowDebugMenu(true);
  }, []);

  // デバッグメニュー: タイトルを10回タップで表示（リリース向けに隠蔽強化）
  const handleTitleTap = useCallback(async () => {
    titleTapCount.current += 1;

    if (titleTapTimer.current) {
      clearTimeout(titleTapTimer.current);
    }

    titleTapTimer.current = setTimeout(() => {
      titleTapCount.current = 0;
    }, 3000);

    if (titleTapCount.current >= 10) {
      titleTapCount.current = 0;
      await openDebugMenu();
    }
  }, [openDebugMenu]);

  const handleDebugAction = useCallback(async (action) => {
    switch (action) {
      case 'clearAuth':
        await clearAuth();
        Alert.alert('完了', 'Google認証をクリアしました');
        break;
      case 'clearSession':
        await AsyncStorage.removeItem(STORAGE_KEYS.SESSION_DATA);
        Alert.alert('完了', 'セッションをクリアしました。アプリを再起動してください');
        break;
      case 'clearAlbumCache':
        await AsyncStorage.removeItem(STORAGE_KEYS.SELECTED_ALBUM);
        Alert.alert('完了', 'アルバムキャッシュをクリアしました');
        break;
      case 'clearLogs':
        await clearDebugLogs();
        setDebugLogs([]);
        Alert.alert('完了', 'ログをクリアしました');
        break;
      case 'checkAuth':
        const auth = await getStoredAuth();
        if (auth) {
          const expiresIn = Math.floor((auth.expiresAt - Date.now()) / 1000);
          Alert.alert('認証状態', `トークンあり\n有効期限: ${expiresIn}秒後`);
        } else {
          Alert.alert('認証状態', 'トークンなし');
        }
        break;
      case 'listApiAlbums':
        try {
          const authData = await getStoredAuth();
          if (!authData) {
            Alert.alert('エラー', 'Google認証が必要です');
            return;
          }
          const result = await listAlbums(authData.accessToken);
          const albumNames = result.albums?.map(a => a.title).join('\n') || 'アルバムなし';
          Alert.alert('APIアルバム一覧', albumNames);
        } catch (e) {
          Alert.alert('エラー', e.message);
        }
        break;
      case 'linkApiAlbum':
        try {
          const authData = await getStoredAuth();
          if (!authData) {
            Alert.alert('エラー', 'Google認証が必要です');
            return;
          }
          // AsyncStorageから現在のアルバム名を取得
          const currentAlbumData = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
          if (!currentAlbumData) {
            Alert.alert('エラー', 'アルバムが選択されていません');
            return;
          }
          const currentAlbum = JSON.parse(currentAlbumData);
          const currentTitle = currentAlbum.title;
          
          const result = await listAlbums(authData.accessToken);
          const matchingAlbum = result.albums?.find(a => 
            a.title === currentTitle || 
            a.title === currentTitle.replace(/^\[.*?\]/, '').trim() ||
            currentTitle.includes(a.title)
          );
          if (matchingAlbum) {
            // APP_CREATED_ALBUMSに保存
            const savedAlbums = await AsyncStorage.getItem('@photov_app_created_albums');
            const appCreatedAlbums = savedAlbums ? JSON.parse(savedAlbums) : {};
            appCreatedAlbums[currentTitle] = {
              apiAlbumId: matchingAlbum.id,
              linkedAt: new Date().toISOString(),
            };
            await AsyncStorage.setItem('@photov_app_created_albums', JSON.stringify(appCreatedAlbums));
            
            // 現在のアルバム設定も更新
            currentAlbum.apiAlbumId = matchingAlbum.id;
            await AsyncStorage.setItem(STORAGE_KEYS.SELECTED_ALBUM, JSON.stringify(currentAlbum));
            
            Alert.alert('完了', `APIアルバムと紐づけました\n\nアルバム: ${matchingAlbum.title}\nID: ${matchingAlbum.id}\n\nアプリを再起動してください`);
          } else {
            // APIアルバム一覧を表示
            const albumList = result.albums?.map(a => a.title).join('\n') || 'なし';
            Alert.alert('エラー', `「${currentTitle}」に一致するAPIアルバムが見つかりません\n\n利用可能:\n${albumList}`);
          }
        } catch (e) {
          Alert.alert('エラー', e.message);
        }
        break;
    }
    setShowDebugMenu(false);
  }, []);

  // デバッグメニューUI
  const renderDebugMenu = () => {
    if (!showDebugMenu) return null;

    const BUILD_VERSION = '2026-02-25 (アップロード後リロードで写真消える問題修正)';

    return (
      <TouchableOpacity
        style={styles.debugOverlay}
        activeOpacity={1}
        onPress={() => setShowDebugMenu(false)}
      >
        <TouchableOpacity
          style={styles.debugMenu}
          activeOpacity={1}
          onPress={(e) => e.stopPropagation()}
        >
          <Text style={styles.debugTitle}>🔧 デバッグメニュー</Text>
          <Text style={styles.debugVersionText}>Ver: {BUILD_VERSION}</Text>

          <TouchableOpacity style={[styles.debugButton, styles.debugCloseButton]} onPress={() => setShowDebugMenu(false)}>
            <Text style={styles.debugCloseText}>✕ 閉じる</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('checkAuth')}>
            <Text style={styles.debugButtonText}>認証状態を確認</Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('listApiAlbums')}>
            <Text style={styles.debugButtonText}>APIアルバム一覧</Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('linkApiAlbum')}>
            <Text style={styles.debugButtonText}>🔗 このアルバムをAPIに紐づけ</Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('clearAuth')}>
            <Text style={styles.debugButtonText}>Google認証クリア</Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('clearSession')}>
            <Text style={styles.debugButtonText}>セッションクリア</Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('clearAlbumCache')}>
            <Text style={styles.debugButtonText}>アルバムキャッシュクリア</Text>
          </TouchableOpacity>
          
          <View style={styles.debugLogSection}>
            <Text style={styles.debugLogTitle}>最新ログ (最後の10件)</Text>
            <View style={styles.debugLogContainer}>
              {debugLogs.slice(-10).reverse().map((log, idx) => {
                const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
                return (
                  <Text key={idx} style={styles.debugLogText}>
                    {time} [{log.category}] {log.message}
                    {log.data ? `\n${log.data.substring(0, 150)}...` : ''}
                  </Text>
                );
              })}
            </View>
          </View>
          
          <TouchableOpacity style={styles.debugButton} onPress={async () => {
            const logText = debugLogs.map(log =>
              `[${log.timestamp}] [${log.category}] ${log.message}\n${log.data ? 'DATA: ' + log.data : ''}`
            ).join('\n---\n');
            try {
              await Share.share({ message: logText });
            } catch (e) {
              Alert.alert('ログ', logText);
            }
          }}>
            <Text style={styles.debugButtonText}>📤 詳細ログを共有</Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('clearLogs')}>
            <Text style={styles.debugButtonText}>ログクリア</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  // セクションデータを行形式に変換
  const sectionsWithRows = useMemo(() => {
    return photoSections.map(section => ({
      ...section,
      data: chunkArray(section.data, numColumns),
    }));
  }, [photoSections]);

  const renderSectionHeader = useCallback(({ section }) => (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{section.title}</Text>
    </View>
  ), []);

  const renderRow = useCallback(({ item: rowPhotos }) => (
    <View style={styles.row}>
      {rowPhotos.map((photo, index) => (
        <View key={photo.mediaKey || `photo-${index}`} style={styles.photoWrapper}>
          <PhotoItem
            photo={photo}
            onPress={() => {
              if (isCoverPhotoMode) {
                handleSelectCoverPhoto(photo);
              } else if (selectionMode) {
                togglePhotoSelection(photo.mediaKey);
              } else {
                openPhotoDetail(photo);
              }
            }}
            onLongPress={() => {
              if (!selectionMode) {
                setSelectionMode(true);
                setSelectedPhotos(new Set([photo.mediaKey]));
              }
            }}
            selectionMode={selectionMode}
            isSelected={selectedPhotos.has(photo.mediaKey)}
          />
        </View>
      ))}
      {Array.from({ length: numColumns - rowPhotos.length }).map((_, index) => (
        <View key={`empty-${index}`} style={styles.photoWrapper} />
      ))}
    </View>
  ), [openPhotoDetail, selectionMode, selectedPhotos, togglePhotoSelection, isCoverPhotoMode, handleSelectCoverPhoto]);

  // WebView（非表示）
  // WebViewエラーハンドリング
  const handleWebViewError = useCallback((syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.error('❌ WebView Error:', nativeEvent.description);
  }, []);

  const renderWebView = () => {
    // sessionDataがない場合は何も表示しない
    if (!sessionData) {
      return null;
    }

    return (
      <WebView
        key={webViewKey} // Gemini推奨：keyを変更してWebViewを再マウント
        ref={webViewRef}
        source={{ uri: 'https://photos.google.com/' }}
        style={styles.hiddenWebView}
        injectedJavaScript={INIT_SCRIPT}
        onLoadEnd={handleWebViewLoadEnd}
        onMessage={handleWebViewMessage}
        onError={handleWebViewError}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        incognito={false}
        cacheEnabled={true}
        userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        onContentProcessDidTerminate={() => {
          console.log('⚠️ WebView process terminated, reloading...');
          webViewRef.current?.reload();
        }}
      />
    );
  };

  if (isLoading && !error) {
    return (
      <SafeAreaView style={styles.container}>
        {renderWebView()}
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#4285F4" />
          <Text style={styles.loadingText}>
            {!isWebViewReady
              ? 'セッションを準備中...'
              : loadProgress.total > 0
                ? `写真を読み込んでいます... (${loadProgress.loaded}/${loadProgress.total})`
                : '写真を読み込んでいます...'}
          </Text>
          {isPollingForUpload && (
            <Text style={styles.pollingText}>
              アップロードを同期中... ({pollingAttempts}/{MAX_POLLING_ATTEMPTS})
            </Text>
          )}
          <TouchableOpacity
            style={styles.resetButton}
            onPress={async () => {
              await AsyncStorage.removeItem(STORAGE_KEYS.SELECTED_ALBUM);
              navigation.replace('AlbumSelectWeb');
            }}
          >
            <Text style={styles.resetButtonText}>別のアルバムを選ぶ</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        {renderWebView()}
        <View style={styles.errorContainer}>
          <Text style={styles.errorIcon}>⚠️</Text>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={loadPhotos}>
            <Text style={styles.retryButtonText}>再試行</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { marginTop: 44 }]}>
        {isCoverPhotoMode ? (
          <>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.backButtonText}>×</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>
              カバー写真を選択
            </Text>
            <View style={styles.rightButtonContainer} />
          </>
        ) : selectionMode ? (
          <>
            <TouchableOpacity
              style={styles.backButton}
              onPress={exitSelectionMode}
            >
              <Text style={styles.backButtonText}>×</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {selectedPhotos.size}枚を選択中
            </Text>
            <View style={styles.selectionActions}>
              <TouchableOpacity 
                style={[styles.uploadButton, styles.downloadButtonStyle]} 
                onPress={downloadSelectedPhotos}
                disabled={isDownloading || selectedPhotos.size === 0}
              >
                {isDownloading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.uploadButtonText}>↓</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.deleteTextButton]} 
                onPress={deleteSelectedPhotos}
                disabled={isDeleting || selectedPhotos.size === 0}
              >
                {isDeleting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.deleteTextButtonText}>削除</Text>
                )}
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <TouchableOpacity
              style={styles.backButton}
              onPress={changeAlbum}
            >
              <Text style={styles.backButtonText}>←</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.titleContainer}
              onLongPress={handleRenameAlbum}
              onPress={handleTitleTap}
              delayLongPress={500}
              activeOpacity={1}
            >
              <Text style={styles.headerTitle} numberOfLines={1}>
                {albumTitle}
              </Text>
            </TouchableOpacity>
            <View style={styles.rightButtonContainer}>
              <TouchableOpacity style={styles.uploadButton} onPress={handleUpload} disabled={isUploading}>
                {isUploading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.uploadButtonText}>＋</Text>
                )}
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>

      <View style={styles.photoCountBar}>
        <Text style={styles.photoCountText}>
          {photos.length} 枚の写真
        </Text>
      </View>

      {photos.length > 0 ? (
        <SectionList
          sections={sectionsWithRows}
          renderItem={renderRow}
          renderSectionHeader={renderSectionHeader}
          keyExtractor={(item, index) => `row-${index}`}
          stickySectionHeadersEnabled={true}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          initialNumToRender={8}
          maxToRenderPerBatch={5}
          windowSize={3}
          updateCellsBatchingPeriod={100}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              colors={['#4285F4']}
            />
          }
        />
      ) : (albumMediaKey || albumInfo.apiAlbumId) && isLoading ? (
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="large" color="#4285F4" />
          <Text style={styles.loadingText}>
            {!isWebViewReady ? 'セッションを準備中...' : '写真を読み込んでいます...'}
          </Text>
        </View>
      ) : (albumMediaKey || albumInfo.apiAlbumId) ? (
        <ScrollView
          contentContainerStyle={styles.emptyContainer}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              colors={['#4285F4']}
            />
          }
        >
          <Text style={styles.emptyIcon}>📷</Text>
          <Text style={styles.emptyText}>写真がありません</Text>
          <TouchableOpacity style={styles.addPhotosButton} onPress={handleUpload}>
            <Text style={styles.addPhotosButtonText}>＋ 写真を追加</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.emptyContainer}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              colors={['#4285F4']}
            />
          }
        >
          <Text style={styles.emptyIcon}>📷</Text>
          <Text style={styles.emptyText}>写真がありません</Text>
          <TouchableOpacity style={styles.addPhotosButton} onPress={handleUpload}>
            <Text style={styles.addPhotosButtonText}>＋ 写真を追加</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* ゴミ箱ボタン（フッター） */}
      {!selectionMode && !isCoverPhotoMode && (
        <TouchableOpacity
          style={styles.trashFooterButton}
          onPress={() => {
            console.log('🗑️ Trash button pressed, sessionData:', !!sessionData);
            navigation.navigate('TrashWeb', { sessionData });
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.trashFooterButtonText}>🗑️ ゴミ箱</Text>
        </TouchableOpacity>
      )}

      {/* アルバムリネームモーダル */}
      <Modal
        visible={showRenameDialog}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowRenameDialog(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>アルバム名を変更</Text>
            <Text style={styles.modalSubtitle}>
              {albumTitle}
            </Text>
            <TextInput
              style={styles.modalInput}
              placeholder="新しいアルバム名を入力"
              value={newAlbumTitle}
              onChangeText={setNewAlbumTitle}
              autoFocus={true}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalCancelButton]}
                onPress={() => {
                  setShowRenameDialog(false);
                  setNewAlbumTitle('');
                }}
              >
                <Text style={styles.modalCancelText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalCreateButton]}
                onPress={performRenameAlbum}
              >
                <Text style={styles.modalCreateText}>変更</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {renderDebugMenu()}
      {renderWebView()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    justifyContent: 'flex-start',
  },
  hiddenWebView: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 15,
    fontSize: 14,
    color: '#666',
  },
  resetButton: {
    marginTop: 30,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
  },
  resetButtonText: {
    fontSize: 14,
    color: '#666',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 15,
  },
  errorText: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    marginBottom: 20,
  },
  retryButton: {
    backgroundColor: '#4285F4',
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 15,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  backButton: {
    padding: 5,
    width: 40,
  },
  backButtonText: {
    fontSize: 15,
    color: '#4285F4',
  },
  rightButtonContainer: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
  },
  uploadButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#4285F4',
    justifyContent: 'center',
    alignItems: 'center',
  },
  uploadButtonText: {
    fontSize: 24,
    color: '#fff',
    fontWeight: 'bold',
    marginTop: -2,
  },
  photoCountBar: {
    backgroundColor: '#f8f8f8',
    paddingVertical: 6,
    paddingHorizontal: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  photoCountText: {
    fontSize: 13,
    color: '#666',
  },
  sectionHeader: {
    backgroundColor: '#f8f8f8',
    paddingVertical: 8,
    paddingHorizontal: 15,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  row: {
    flexDirection: 'row',
  },
  photoWrapper: {
    width: imageSize,
    height: imageSize,
  },
  photoContainer: {
    flex: 1,
    margin: 1,
  },
  photoInner: {
    width: '100%',
    height: '100%',
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  loadingOverlay: {
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderPhoto: {
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    fontSize: 24,
  },
  videoIndicator: {
    position: 'absolute',
    bottom: 5,
    right: 5,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  videoIndicatorText: {
    color: '#fff',
    fontSize: 10,
  },
  durationText: {
    color: '#fff',
    fontSize: 10,
    marginLeft: 3,
  },
  livePhotoBadge: {
    position: 'absolute',
    top: 5,
    left: 5,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  livePhotoText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#333',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 10,
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 20,
  },
  addPhotosButton: {
    backgroundColor: '#4285F4',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  addPhotosButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  // デバッグメニュースタイル
  debugOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    zIndex: 1000,
    justifyContent: 'center',
    alignItems: 'center',
  },
  debugMenu: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '90%',
    maxHeight: '80%',
  },
  debugTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 15,
    textAlign: 'center',
  },
  debugButton: {
    backgroundColor: '#f0f0f0',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  debugButtonText: {
    fontSize: 14,
    color: '#333',
    textAlign: 'center',
  },
  debugCloseButton: {
    backgroundColor: '#4285F4',
    marginTop: 10,
  },
  debugCloseText: {
    color: '#fff',
    fontSize: 14,
    textAlign: 'center',
    fontWeight: '600',
  },
  debugLogSection: {
    marginTop: 10,
    marginBottom: 10,
  },
  debugLogTitle: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 5,
    color: '#666',
  },
  debugLogContainer: {
    backgroundColor: '#1a1a1a',
    padding: 10,
    borderRadius: 6,
    maxHeight: 150,
  },
  debugLogText: {
    fontSize: 10,
    color: '#0f0',
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  selectedPhoto: {
    opacity: 0.7,
  },
  selectionIndicator: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectionIndicatorSelected: {
    backgroundColor: '#4285F4',
    borderColor: '#4285F4',
  },
  checkmark: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  selectionActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  downloadButtonStyle: {
    backgroundColor: '#34A853',
  },
  deleteTextButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: '#EA4335',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteTextButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  renameButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#666',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  renameButtonText: {
    fontSize: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 15,
    textAlign: 'center',
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalCancelButton: {
    backgroundColor: '#f0f0f0',
  },
  modalCancelText: {
    fontSize: 16,
    color: '#666',
    fontWeight: '600',
  },
  modalCreateButton: {
    backgroundColor: '#4285F4',
  },
  modalCreateText: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '600',
  },
  trashFooterButton: {
    position: 'absolute',
    bottom: 30,
    alignSelf: 'center',
    backgroundColor: '#f5f5f5',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
    zIndex: 999,
  },
  trashFooterButtonText: {
    fontSize: 15,
    color: '#333',
    fontWeight: '500',
  },
});
