import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  Modal,
  TextInput,
  Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import {
  getPhotoUrl,
  generateGetAlbumsScript,
  parseAlbumsResponse,
  generateRequestId,
} from '../services/webViewApiClient';
import { deleteAlbum } from '../services/googlePhotosWebApi';
import {
  clearAuth,
  getStoredAuth,
  getDebugLogs,
  clearDebugLogs,
  createAlbum,
  shareAlbum,
  addDebugLog,
  useGoogleAuthConfig,
  handleAuthResponse,
  updateAlbumTitle,
  syncAppCreatedAlbums,
  listAlbums,
} from '../services/googleAuthService';

const STORAGE_KEYS = {
  SELECTED_ALBUM: '@photov_selected_album',
  SESSION_DATA: '@photov_session_data',
  APP_CREATED_ALBUMS: '@photov_app_created_albums', // PhotoVで作成したアルバムのリスト
};

const BUILD_VERSION = 'v0.3.6';
// Force rebuild

/**
 * アルバム選択画面
 * 
 * WebAuthScreenから渡されたアルバムデータを表示。
 * リフレッシュ時は内蔵WebViewで再取得。
 */
export default function AlbumSelectWebScreen({ navigation, route }) {
  // Safe Area insets
  const insets = useSafeAreaInsets();
  
  // WebAuthScreenから渡されたデータ
  const initialAlbums = route?.params?.albums || [];
  const initialSessionData = route?.params?.sessionData || null;

  // デバッグログ
  console.log('📦 AlbumSelectWebScreen params:', {
    hasAlbums: initialAlbums.length,
    hasSessionData: !!initialSessionData,
    sessionKeys: initialSessionData ? Object.keys(initialSessionData) : [],
  });

  const [albums, setAlbums] = useState(initialAlbums);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [sessionData, setSessionData] = useState(initialSessionData);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [showDebugMenu, setShowDebugMenu] = useState(false);
  const [debugLogs, setDebugLogs] = useState([]);
  const [showCreateAlbum, setShowCreateAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [isCreatingAlbum, setIsCreatingAlbum] = useState(false);
  const [pendingAlbumName, setPendingAlbumName] = useState(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameAlbum, setRenameAlbum] = useState(null);
  const [newTitle, setNewTitle] = useState('');

  // Google認証hook
  const [googleRequest, googleResponse, promptGoogleAsync] = useGoogleAuthConfig();
  
  const webViewRef = useRef(null);
  const pendingRequest = useRef(null);
  const titleTapCount = useRef(0);
  const titleTapTimer = useRef(null);

  // 初期データがなければWebAuthに戻す
  useEffect(() => {
    if (!initialAlbums.length && !initialSessionData) {
      loadSessionAndRedirect();
    }
  }, []);
  
  // autoReselect: アップロード後に自動で前のアルバムを再選択
  useEffect(() => {
    if (route?.params?.autoReselect) {
      const reselect = async () => {
        try {
          const saved = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
          if (saved) {
            const album = JSON.parse(saved);
            console.log('🔄 Auto-reselecting album:', album.title);
            navigation.replace('HomeWeb', {
              albumMediaKey: album.mediaKey,
              albumTitle: album.title,
              authKey: album.authKey,
              apiAlbumId: album.apiAlbumId,
              isFromAutoLoad: true, // 自動再選択なので無限ループ防止
            });
          }
        } catch (e) {
          console.error('Auto-reselect error:', e);
        }
      };
      reselect();
    }
  }, [route?.params?.autoReselect, navigation]);

  // WebViewがReadyになったらアルバム取得（初期データがない場合のみ）
  useEffect(() => {
    if (isWebViewReady && albums.length === 0 && sessionData && isLoading) {
      console.log('📥 Triggering loadAlbums (WebView ready, no albums)');
      loadAlbums(true);  // forceReady=true でクロージャ問題を回避
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWebViewReady, albums.length, sessionData, isLoading]);

  const loadSessionAndRedirect = async () => {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_DATA);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.wizData) {
          const sd = {
            at: data.wizData.SNlM0e,
            sid: data.wizData.FdrFJe,
            bl: data.wizData.cfb2h,
          };
          setSessionData(sd);
          setIsLoading(true);
          // WebViewがロードされたら自動でアルバム取得
          return;
        }
      }
      // セッションなし → WebAuthへ
      navigation.replace('WebAuth');
    } catch (err) {
      console.error('セッション読み込みエラー:', err);
      navigation.replace('WebAuth');
    }
  };

  // WebViewがロード完了したらアルバム取得
  const handleWebViewLoadEnd = useCallback(() => {
    console.log('🌐 AlbumSelect WebView loaded', {
      albumsLength: albums.length,
      hasSessionData: !!sessionData,
      isLoading,
    });
    setIsWebViewReady(true);
  }, [albums.length, sessionData, isLoading]);

  const handleWebViewMessage = useCallback((event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      
      if (message.type === 'API_RESPONSE' && pendingRequest.current) {
        if (message.requestId === pendingRequest.current.requestId) {
          if (message.success) {
            pendingRequest.current.resolve(message.data);
          } else {
            pendingRequest.current.reject(new Error(message.error || 'Unknown error'));
          }
          pendingRequest.current = null;
        }
      }
    } catch (err) {
      console.error('メッセージ処理エラー:', err);
    }
  }, []);

  const loadAlbums = useCallback(async (forceReady = false) => {
    const ready = forceReady || isWebViewReady;
    console.log('🔍 loadAlbums called:', {
      hasSessionData: !!sessionData,
      hasWebViewRef: !!webViewRef.current,
      isWebViewReady,
      forceReady,
    });
    if (!sessionData || !webViewRef.current || !ready) {
      console.log('WebViewまたはセッションが準備できていません');
      return;
    }

    setError(null);

    const requestId = generateRequestId();
    const script = generateGetAlbumsScript(requestId, sessionData, null, 100);

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequest.current = null;
        reject(new Error('タイムアウト'));
      }, 30000);

      pendingRequest.current = {
        requestId,
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
    });

    webViewRef.current.injectJavaScript(script);

    try {
      const data = await promise;
      const parsed = parseAlbumsResponse(data);
      
      const sortedAlbums = [...parsed.items]
        .filter(album => album.title !== 'TestAlbum') // テストアルバムを除外
        .sort((a, b) => {
          if (a.isShared && !b.isShared) return -1;
          if (!a.isShared && b.isShared) return 1;
          return (b.modifiedTimestamp || 0) - (a.modifiedTimestamp || 0);
        });

      // PhotoVで作成したアルバムの情報を付与（新しい構造：apiAlbumIdがキー）
      try {
        const savedAlbums = await AsyncStorage.getItem(STORAGE_KEYS.APP_CREATED_ALBUMS);
        const appCreatedAlbums = savedAlbums ? JSON.parse(savedAlbums) : {};

        // APP_CREATED_ALBUMSから全てのapiAlbumIdを取得
        const apiAlbumIds = Object.keys(appCreatedAlbums);

        sortedAlbums.forEach(album => {
          // このアルバムのmediaKeyから実際のapiAlbumIdを探す
          // 非公式APIのmediaKeyと公式APIのalbumIdは異なるため、
          // APP_CREATED_ALBUMSに登録されているアルバムを探す
          for (const apiAlbumId of apiAlbumIds) {
            const albumData = appCreatedAlbums[apiAlbumId];
            // タイトルで照合（完全一致または部分一致）
            if (albumData.title === album.title || albumData.originalTitle === album.title) {
              album.apiAlbumId = apiAlbumId;
              album.createdByApp = true;
              break;
            }
          }
        });
      } catch (e) {
        console.warn('APP_CREATED_ALBUMS読み込みエラー:', e);
      }

      setAlbums(sortedAlbums);
    } catch (err) {
      console.error('アルバム取得エラー:', err);

      // タイムアウトエラーはサイレント（表示しない）
      const errorMsg = err.message || '';
      if (errorMsg.toLowerCase().includes('timeout') ||
          errorMsg.includes('タイムアウト')) {
        console.log('タイムアウトエラー（サイレント）:', errorMsg);
        return;
      }

      // アルバムが既にある場合はエラー表示しない（バックグラウンドエラー）
      if (albums.length > 0) {
        console.log('アルバム表示中のエラー（サイレント）:', errorMsg);
        return;
      }

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
  }, [sessionData, isWebViewReady]);

  const onRefresh = useCallback(() => {
    console.log('🔄 onRefresh called:', { isWebViewReady, hasSessionData: !!sessionData });
    setIsRefreshing(true);
    if (isWebViewReady && sessionData) {
      loadAlbums();
    } else {
      setIsRefreshing(false);
    }
  }, [loadAlbums, isWebViewReady, sessionData]);

  // デバッグメニュー: タイトルを10回タップで表示（リリース向けに隠蔽強化）
  const handleTitleTap = useCallback(() => {
    titleTapCount.current += 1;

    if (titleTapTimer.current) {
      clearTimeout(titleTapTimer.current);
    }

    titleTapTimer.current = setTimeout(() => {
      titleTapCount.current = 0;
    }, 3000);

    if (titleTapCount.current >= 3) {
      titleTapCount.current = 0;
      openDebugMenu();
    }
  }, []);

  const openDebugMenu = useCallback(async () => {
    const logs = await getDebugLogs();
    setDebugLogs(logs);
    setShowDebugMenu(true);
  }, []);

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
      case 'relogin':
        await AsyncStorage.removeItem(STORAGE_KEYS.SESSION_DATA);
        navigation.replace('WebAuth');
        break;
      case 'syncAlbums':
        try {
          console.log('🔄 [SYNC] Starting sync...');
          let auth = await getStoredAuth();
          console.log('🔄 [SYNC] Stored auth:', auth ? 'Found' : 'Not found');

          if (!auth || !auth.accessToken) {
            console.log('🔄 [SYNC] Requesting Google auth...');
            // 認証が必要
            const result = await promptGoogleAsync();
            console.log('🔄 [SYNC] Google auth result:', result ? 'Success' : 'Failed');
            console.log('🔄 [SYNC] Google auth response:', JSON.stringify(result, null, 2));

            if (!result) {
              Alert.alert('エラー', '認証が必要です。Google認証をキャンセルしました。');
              break;
            }

            // handleAuthResponseで認証情報を保存
            const savedAuth = await handleAuthResponse(result);
            console.log('🔄 [SYNC] handleAuthResponse result:', savedAuth ? 'Success' : 'Failed');

            if (!savedAuth) {
              Alert.alert('エラー', '認証情報の保存に失敗しました。\n\nログを確認してください。');
              break;
            }

            auth = savedAuth;
            console.log('🔄 [SYNC] Auth ready:', auth ? 'Found' : 'Not found');
          }

          console.log('🔄 [SYNC] Calling syncAppCreatedAlbums...');
          const syncResult = await syncAppCreatedAlbums(auth.accessToken);
          console.log('🔄 [SYNC] Sync result:', syncResult);

          Alert.alert(
            'Sync完了',
            `${syncResult.synced}個のアルバムをsyncしました\n（${syncResult.new}個が新規登録）\n\nアルバム一覧を更新します。`
          );
          onRefresh();
        } catch (error) {
          console.error('🔄 [SYNC] Error:', error);
          Alert.alert('エラー', `Sync失敗\n\n${error.message}`);
        }
        break;
    }
    setShowDebugMenu(false);
  }, [navigation, promptGoogleAsync, onRefresh]);

  // Google認証レスポンスを監視
  useEffect(() => {
    if (googleResponse?.type === 'success' && pendingAlbumName) {
      handleAuthResponse(googleResponse).then(authData => {
        if (authData) {
          performCreateAlbum(pendingAlbumName, authData.accessToken);
        }
        setPendingAlbumName(null);
      });
    }
  }, [googleResponse, pendingAlbumName]);

  // 実際のアルバム作成処理
  const performCreateAlbum = useCallback(async (albumName, accessToken) => {
    setIsCreatingAlbum(true);
    addDebugLog('ALBUM', `Creating album: ${albumName}`);
    
    try {
      // アルバム作成
      const album = await createAlbum(accessToken, albumName);
      console.log('📝 [PERFORM_CREATE] Album object:', JSON.stringify(album, null, 2));
      console.log('📝 [PERFORM_CREATE] Album ID:', album.id);
      addDebugLog('ALBUM', `Album created: ${album.id}`);
      
      // 共有設定（オプション - 失敗しても続行）
      let shareableUrl = null;
      try {
        const shareResult = await shareAlbum(accessToken, album.id);
        shareableUrl = shareResult.shareInfo?.shareableUrl;
        addDebugLog('ALBUM', `Album shared: ${shareableUrl}`);
      } catch (shareErr) {
        addDebugLog('ALBUM', `Share skipped (not required): ${shareErr.message}`);
      }
      
      // PhotoVで作成したアルバムのリストに追加（新しい構造：apiAlbumIdがキー）
      try {
        const savedAlbums = await AsyncStorage.getItem(STORAGE_KEYS.APP_CREATED_ALBUMS);
        const appCreatedAlbums = savedAlbums ? JSON.parse(savedAlbums) : {};
        console.log('📝 [PERFORM_CREATE] Before save - APP_CREATED_ALBUMS:', JSON.stringify(appCreatedAlbums, null, 2));

        const albumData = {
          title: albumName,
          originalTitle: albumName,
          shareableUrl: shareableUrl,
          createdAt: new Date().toISOString(),
        };
        console.log('📝 [PERFORM_CREATE] Saving album data for key "' + album.id + '":', JSON.stringify(albumData, null, 2));

        appCreatedAlbums[album.id] = albumData;
        const toSave = JSON.stringify(appCreatedAlbums);
        console.log('📝 [PERFORM_CREATE] Saving to AsyncStorage:', toSave);

        await AsyncStorage.setItem(STORAGE_KEYS.APP_CREATED_ALBUMS, toSave);
        addDebugLog('ALBUM', `Saved to app created albums: ${album.id}`);
      } catch (e) {
        addDebugLog('ALBUM', `Failed to save app created album: ${e.message}`);
      }
      
      // アルバム作成完了 - 自動的にそのアルバムを選択
      setShowCreateAlbum(false);
      setNewAlbumName('');
      
      // 作成したアルバムを選択してHomeWebに遷移
      const selectedAlbumData = {
        mediaKey: null, // iCloudアルバムではないのでnull
        title: albumName,
        isShared: false,
        authKey: null,
        apiAlbumId: album.id,
      };
      console.log('📝 [PERFORM_CREATE] Saving to SELECTED_ALBUM:', JSON.stringify(selectedAlbumData, null, 2));
      await AsyncStorage.setItem(STORAGE_KEYS.SELECTED_ALBUM, JSON.stringify(selectedAlbumData));
      
      Alert.alert(
        'アルバム作成完了',
        `「${albumName}」を作成しました。`,
        [
          {
            text: 'アルバムを開く',
            onPress: () => {
              navigation.navigate('HomeWeb', {
                albumMediaKey: null,
                albumTitle: albumName,
                authKey: null,
                apiAlbumId: album.id,
                isFromAutoLoad: true, // 自動読み込みフラグで無限ループ防止
              });
            },
          },
        ]
      );
    } catch (error) {
      addDebugLog('ALBUM', `Create album error: ${error.message}`);
      Alert.alert('エラー', `アルバム作成に失敗しました\n\n${error.message}`);
    } finally {
      setIsCreatingAlbum(false);
    }
  }, [onRefresh]);

  // アルバム作成ボタン押下
  const handleCreateAlbum = useCallback(async () => {
    if (!newAlbumName.trim()) {
      Alert.alert('エラー', 'アルバム名を入力してください');
      return;
    }
    
    // Google認証を確認
    const auth = await getStoredAuth();
    if (!auth) {
      // 認証がない場合は自動で認証を開始
      setPendingAlbumName(newAlbumName.trim());
      promptGoogleAsync();
      return;
    }
    
    // 認証済みならそのまま作成
    await performCreateAlbum(newAlbumName.trim(), auth.accessToken);
  }, [newAlbumName, promptGoogleAsync, performCreateAlbum]);

  // 共有リンクをコピー
  const handleCopyShareLink = useCallback(async (album) => {
    try {
      // APP_CREATED_ALBUMSからshareableUrlを取得
      const savedAlbums = await AsyncStorage.getItem(STORAGE_KEYS.APP_CREATED_ALBUMS);
      const appCreatedAlbums = savedAlbums ? JSON.parse(savedAlbums) : {};
      const albumData = appCreatedAlbums[album.apiAlbumId];
      
      if (albumData?.shareableUrl) {
        await Clipboard.setStringAsync(albumData.shareableUrl);
        Alert.alert('コピー完了', '共有リンクをクリップボードにコピーしました');
      } else {
        Alert.alert('エラー', '共有リンクが見つかりません。アルバムを再作成してください。');
      }
    } catch (e) {
      console.error('共有リンクコピーエラー:', e);
      Alert.alert('エラー', 'コピーに失敗しました');
    }
  }, []);

  // アルバム削除処理
  const performDeleteAlbum = useCallback(async (album) => {
    try {
      await deleteAlbum(album.apiAlbumId);

      // APP_CREATED_ALBUMSから削除
      const savedAlbums = await AsyncStorage.getItem(STORAGE_KEYS.APP_CREATED_ALBUMS);
      if (savedAlbums) {
        const appCreatedAlbums = JSON.parse(savedAlbums);
        delete appCreatedAlbums[album.apiAlbumId];
        await AsyncStorage.setItem(STORAGE_KEYS.APP_CREATED_ALBUMS, JSON.stringify(appCreatedAlbums));
      }

      // SELECTED_ALBUMが同じアルバムなら削除
      const savedSelected = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
      if (savedSelected) {
        const selected = JSON.parse(savedSelected);
        if (selected.apiAlbumId === album.apiAlbumId) {
          await AsyncStorage.removeItem(STORAGE_KEYS.SELECTED_ALBUM);
        }
      }

      // ローカルstateから削除
      setAlbums(prev => prev.filter(a => a.apiAlbumId !== album.apiAlbumId));
      addDebugLog('ALBUM', `Album deleted: ${album.title}`);
      Alert.alert('削除完了', `「${album.title}」を削除しました`);
    } catch (error) {
      addDebugLog('ALBUM', `Delete album error: ${error.message}`);
      Alert.alert('エラー', `アルバムの削除に失敗しました\n\n${error.message}`);
    }
  }, []);

  // アルバムリネームボタン押下
  const handleAlbumLongPress = useCallback((album) => {
    // PhotoVで作成したアルバムのみメニュー表示
    if (!album.createdByApp || !album.apiAlbumId) {
      return;
    }

    Alert.alert(
      album.title,
      'アルバム操作',
      [
        {
          text: '共有リンクをコピー',
          onPress: () => handleCopyShareLink(album),
        },
        {
          text: 'カバー写真を変更',
          onPress: () => handleChangeCoverPhoto(album),
        },
        {
          text: 'アルバムをリネーム',
          onPress: () => {
            setRenameAlbum(album);
            setNewTitle(album.title);
            setShowRenameDialog(true);
          },
        },
        {
          text: 'アルバムを削除',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'アルバムを削除',
              `「${album.title}」を削除しますか？\n\nアルバム内の写真はライブラリに残ります。`,
              [
                { text: 'キャンセル', style: 'cancel' },
                { text: '削除', style: 'destructive', onPress: () => performDeleteAlbum(album) },
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
  }, [handleCopyShareLink]);

  const handleChangeCoverPhoto = useCallback((album) => {
    // カバー写真選択モードでHomeWebScreenに遷移
    navigation.navigate('HomeWeb', {
      albumMediaKey: album.mediaKey,
      albumTitle: album.title,
      authKey: album.authKey,
      apiAlbumId: album.apiAlbumId,
      selectCoverPhoto: true, // カバー写真選択モード
    });
  }, [navigation]);

  // 実際のリネーム処理
  const performRenameAlbum = useCallback(async () => {
    if (!newTitle.trim()) {
      Alert.alert('エラー', '新しいアルバム名を入力してください');
      return;
    }

    if (!renameAlbum) {
      return;
    }

    const oldTitle = renameAlbum.title;
    const trimmedNewTitle = newTitle.trim();

    if (oldTitle === trimmedNewTitle) {
      setShowRenameDialog(false);
      return;
    }

    setShowRenameDialog(false);
    setIsLoading(true);
    addDebugLog('ALBUM', `Renaming album: ${oldTitle} -> ${trimmedNewTitle}`);

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
      await updateAlbumTitle(auth.accessToken, renameAlbum.apiAlbumId, trimmedNewTitle);
      addDebugLog('ALBUM', `Album renamed successfully: ${trimmedNewTitle}`);

      // AsyncStorageのAPP_CREATED_ALBUMSを更新（新しい構造：apiAlbumIdがキー）
      try {
        const savedAlbums = await AsyncStorage.getItem(STORAGE_KEYS.APP_CREATED_ALBUMS);
        const appCreatedAlbums = savedAlbums ? JSON.parse(savedAlbums) : {};

        // apiAlbumIdをキーにしてtitleを更新
        if (appCreatedAlbums[renameAlbum.apiAlbumId]) {
          appCreatedAlbums[renameAlbum.apiAlbumId].title = trimmedNewTitle;
          await AsyncStorage.setItem(STORAGE_KEYS.APP_CREATED_ALBUMS, JSON.stringify(appCreatedAlbums));
          addDebugLog('ALBUM', `Updated APP_CREATED_ALBUMS title: ${oldTitle} -> ${trimmedNewTitle}`);
        }

        // 現在選択中のアルバムが対象の場合、SELECTED_ALBUMも更新
        const selectedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
        if (selectedAlbum) {
          const selectedData = JSON.parse(selectedAlbum);
          if (selectedData.title === oldTitle) {
            selectedData.title = trimmedNewTitle;
            await AsyncStorage.setItem(STORAGE_KEYS.SELECTED_ALBUM, JSON.stringify(selectedData));
            addDebugLog('ALBUM', 'Updated SELECTED_ALBUM title');
          }
        }
      } catch (e) {
        addDebugLog('ALBUM', `Failed to update AsyncStorage: ${e.message}`);
      }

      Alert.alert(
        'リネーム完了',
        `「${oldTitle}」を「${trimmedNewTitle}」に変更しました。`,
        [{ text: 'OK', onPress: () => onRefresh() }]
      );
    } catch (error) {
      addDebugLog('ALBUM', `Rename album error: ${error.message}`);
      Alert.alert('エラー', `アルバム名の変更に失敗しました\n\n${error.message}`);
    } finally {
      setIsLoading(false);
      setRenameAlbum(null);
      setNewTitle('');
    }
  }, [newTitle, renameAlbum, promptGoogleAsync, onRefresh]);

  const selectAlbum = async (album) => {
    try {
      // PhotoVで作成したアルバムか確認（新しい構造：apiAlbumIdがキー）
      let apiAlbumId = album.apiAlbumId || null;
      if (!apiAlbumId) {
        try {
          const savedAlbums = await AsyncStorage.getItem(STORAGE_KEYS.APP_CREATED_ALBUMS);
          console.log('🔍 [SELECT] APP_CREATED_ALBUMS raw:', savedAlbums);
          if (savedAlbums) {
            const appCreatedAlbums = JSON.parse(savedAlbums);
            console.log('🔍 [SELECT] Parsed albums:', JSON.stringify(appCreatedAlbums, null, 2));
            console.log('🔍 [SELECT] Looking for album.title:', album.title);
            // 新しい構造：apiAlbumIdをキーにして、titleで検索
            for (const [id, data] of Object.entries(appCreatedAlbums)) {
              if (data.title === album.title || data.originalTitle === album.title) {
                apiAlbumId = id;
                console.log('🔍 [SELECT] Found app created album ID:', apiAlbumId);
                addDebugLog('ALBUM', `Found app created album: ${apiAlbumId}`);
                break;
              }
            }
            if (!apiAlbumId) {
              console.log('🔍 [SELECT] Album not found in app created albums');
            }
          } else {
            console.log('🔍 [SELECT] No APP_CREATED_ALBUMS in storage');
          }
        } catch (e) {
          console.log('Failed to check app created albums:', e);
        }
      }

      // フォールバック1: APP_CREATED_ALBUMSから取れなかった場合、Google Photos APIで検索
      if (!apiAlbumId) {
        try {
          const auth = await getStoredAuth();
          if (auth?.accessToken) {
            addDebugLog('ALBUM', 'Fallback: searching album via API listAlbums');
            const albumsList = await listAlbums(auth.accessToken);
            const match = (albumsList.albums || []).find(a => a.title === album.title);
            if (match) {
              apiAlbumId = match.id;
              addDebugLog('ALBUM', `Fallback: Found album via API: ${apiAlbumId}`);
            } else {
              addDebugLog('ALBUM', 'Fallback: Album not found via API either');
            }
          }
        } catch (e) {
          addDebugLog('ALBUM', `Fallback listAlbums failed: ${e.message}`);
        }
      }

      // フォールバック2: 既存のSELECTED_ALBUMに同名アルバムのapiAlbumIdがあれば引き継ぐ
      if (!apiAlbumId) {
        try {
          const existingSaved = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
          if (existingSaved) {
            const existingData = JSON.parse(existingSaved);
            if (existingData.title === album.title && existingData.apiAlbumId) {
              apiAlbumId = existingData.apiAlbumId;
              addDebugLog('ALBUM', `Fallback: Preserved apiAlbumId from existing SELECTED_ALBUM: ${apiAlbumId}`);
            }
          }
        } catch (e) {
          addDebugLog('ALBUM', `Fallback SELECTED_ALBUM read failed: ${e.message}`);
        }
      }

      const selectedAlbumData = {
        mediaKey: album.mediaKey,
        title: album.title,
        isShared: album.isShared,
        authKey: album.authKey,
        apiAlbumId: apiAlbumId, // PhotoV作成アルバムの場合のみ値あり
      };
      console.log('🔍 [SELECT] Saving to SELECTED_ALBUM:', JSON.stringify(selectedAlbumData, null, 2));
      await AsyncStorage.setItem(STORAGE_KEYS.SELECTED_ALBUM, JSON.stringify(selectedAlbumData));

      console.log('🔍 [SELECT] Navigating to HomeWeb with params:', JSON.stringify({
        albumMediaKey: album.mediaKey,
        albumTitle: album.title,
        authKey: album.authKey,
        apiAlbumId: apiAlbumId,
      }, null, 2));

      navigation.navigate('HomeWeb', {
        albumMediaKey: album.mediaKey,
        albumTitle: album.title,
        authKey: album.authKey,
        apiAlbumId: apiAlbumId,
        isFromAutoLoad: true, // 明示的な選択なので自動読み込み不要
      });
    } catch (err) {
      console.error('アルバム選択エラー:', err);
      Alert.alert('エラー', 'アルバムの選択に失敗しました');
    }
  };

  const renderAlbumItem = ({ item }) => {
    const thumbUrl = getPhotoUrl(item.thumb, 200, 200, true);

    return (
      <TouchableOpacity
        style={styles.albumItem}
        onPress={() => selectAlbum(item)}
        onLongPress={() => handleAlbumLongPress(item)}
        delayLongPress={500}
        activeOpacity={0.7}
      >
        <View style={styles.albumThumbContainer}>
          {thumbUrl ? (
            <Image
              source={{ uri: thumbUrl }}
              style={styles.albumThumb}
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.albumThumb, styles.placeholderThumb]}>
              <Text style={styles.placeholderIcon}>📁</Text>
            </View>
          )}
          {item.isShared && (
            <View style={styles.sharedBadge}>
              <Text style={styles.sharedBadgeText}>共有</Text>
            </View>
          )}
        </View>
        <View style={styles.albumInfo}>
          <Text style={styles.albumTitle} numberOfLines={2}>
            {item.title || '無題のアルバム'}
          </Text>
          <Text style={styles.albumCount}>
            {item.itemCount || 0} 枚
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const clearSessionAndRestart = async () => {
    try {
      await AsyncStorage.multiRemove([
        '@photov_session_data',
        '@photov_selected_album',
        '@photov_auth_mode',
      ]);
      navigation.reset({
        index: 0,
        routes: [{ name: 'Startup' }],
      });
    } catch (err) {
      console.error('セッションクリアエラー:', err);
    }
  };

  // ローディング状態
  if (isLoading && albums.length === 0) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* 非表示のWebView（API呼び出し用） */}
        {sessionData && (
          <WebView
            ref={webViewRef}
            source={{ uri: 'https://photos.google.com/' }}
            style={styles.hiddenWebView}
            onLoadEnd={handleWebViewLoadEnd}
            onMessage={handleWebViewMessage}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            sharedCookiesEnabled={true}
            thirdPartyCookiesEnabled={true}
            incognito={false}
            cacheEnabled={true}
            userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          />
        )}
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#4285F4" />
          <Text style={styles.loadingText}>アルバムを読み込んでいます...</Text>
        </View>
      </View>
    );
  }

  // エラー状態
  if (error && albums.length === 0) {
    const isNetworkError = error.includes('ネットワーク') || error.includes('タイムアウト');
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {sessionData && (
          <WebView
            ref={webViewRef}
            source={{ uri: 'https://photos.google.com/' }}
            style={styles.hiddenWebView}
            onLoadEnd={handleWebViewLoadEnd}
            onMessage={handleWebViewMessage}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            sharedCookiesEnabled={true}
            thirdPartyCookiesEnabled={true}
            incognito={false}
            cacheEnabled={true}
            userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          />
        )}
        <View style={styles.errorContainer}>
          <Text style={styles.errorIcon}>{isNetworkError ? '📡' : '⚠️'}</Text>
          <Text style={styles.errorText}>{error}</Text>
          {isNetworkError && (
            <Text style={styles.errorHint}>インターネット接続を確認してください</Text>
          )}
          <TouchableOpacity style={styles.retryButton} onPress={loadAlbums}>
            <Text style={styles.retryButtonText}>再試行</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.resetButton} onPress={clearSessionAndRestart}>
            <Text style={styles.resetButtonText}>最初からやり直す</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* デバッグメニュー */}
      {showDebugMenu && (
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

            <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('clearAuth')}>
              <Text style={styles.debugButtonText}>Google認証クリア</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('clearSession')}>
              <Text style={styles.debugButtonText}>セッションクリア</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('relogin')}>
              <Text style={styles.debugButtonText}>再ログイン</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.debugButton, { backgroundColor: '#34A853' }]} onPress={() => handleDebugAction('syncAlbums')}>
              <Text style={styles.debugButtonText}>🔄 Sync共有アルバム</Text>
            </TouchableOpacity>

            <View style={styles.debugLogSection}>
              <Text style={styles.debugLogTitle}>最新ログ (最後の10件)</Text>
              <ScrollView style={styles.debugLogContainer}>
                {debugLogs.slice(-10).reverse().map((log, idx) => {
                  const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('ja-JP', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                  }) : '';
                  return (
                    <Text key={idx} style={styles.debugLogText}>
                      {time} [{log.category}] {log.message}
                      {log.data ? `\n${log.data.substring(0, 150)}...` : ''}
                    </Text>
                  );
                })}
              </ScrollView>
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
              <Text style={styles.debugButtonText}>📤 ログを共有</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.debugButton} onPress={() => handleDebugAction('clearLogs')}>
              <Text style={styles.debugButtonText}>ログクリア</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* ヘッダー */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerTitle}>アルバムを選択 <Text style={styles.versionText}>{BUILD_VERSION}</Text></Text>
          </View>
          <View style={styles.headerButtons}>
            <TouchableOpacity
              style={styles.createAlbumButton}
              onPress={() => setShowCreateAlbum(true)}
            >
              <Text style={styles.createAlbumButtonText}>＋ 新規</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.manageButton}
              onPress={() => navigation.navigate('WebManage', {
                initialUrl: 'https://photos.google.com/',
              })}
            >
              <Text style={styles.manageButtonText}>管理</Text>
            </TouchableOpacity>
          </View>
        </View>
        <TouchableOpacity onPress={handleTitleTap} activeOpacity={1}>
          <Text style={styles.headerSubtitle}>
            表示したいアルバムを選んでください（長押しでメニュー）
          </Text>
        </TouchableOpacity>
      </View>

      {/* アルバムリスト */}
      <ScrollView
        style={styles.albumFlatList}
        contentContainerStyle={[styles.albumListGrid, { paddingBottom: 80 + insets.bottom }]}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            colors={['#4285F4']}
          />
        }
      >
        {albums.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>📷</Text>
            <Text style={styles.emptyText}>アルバムが見つかりません</Text>
            <Text style={styles.emptySubtext}>
              Googleフォトでアルバムを作成してください
            </Text>
          </View>
        ) : (
          <View style={styles.albumGrid}>
            {albums.map((item) => (
              <View key={item.mediaKey} style={styles.albumGridItem}>
                {renderAlbumItem({ item })}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* フッター */}
      <TouchableOpacity
        style={[styles.footerButton, { bottom: insets.bottom }]}
        onPress={() => navigation.navigate('WebManage')}
      >
        <Text style={styles.manageButtonText}>📋 Googleフォトで管理</Text>
      </TouchableOpacity>

      {/* 非表示のWebView（リフレッシュ用） */}
      {sessionData && (
        <WebView
          ref={webViewRef}
          source={{ uri: 'https://photos.google.com/' }}
          style={styles.hiddenWebView}
          onLoadEnd={handleWebViewLoadEnd}
          onMessage={handleWebViewMessage}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          sharedCookiesEnabled={true}
          thirdPartyCookiesEnabled={true}
          incognito={false}
          cacheEnabled={true}
          userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  hiddenWebView: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 15,
    fontSize: 15,
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
    marginBottom: 10,
  },
  errorHint: {
    fontSize: 13,
    color: '#999',
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
  resetButton: {
    marginTop: 15,
    padding: 10,
  },
  resetButtonText: {
    color: '#999',
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    backgroundColor: '#f8f8f8',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 5,
  },
  versionText: {
    fontSize: 12,
    fontWeight: 'normal',
    color: '#999',
  },
  manageButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#fff',
    borderRadius: 8,
  },
  manageButtonText: {
    color: '#4285F4',
    fontSize: 14,
    fontWeight: '500',
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#666',
  },
  albumFlatList: {
    flex: 1,
    backgroundColor: '#f8f8f8',
  },
  albumList: {
    padding: 10,
    flexGrow: 1,
    justifyContent: 'flex-start',
  },
  albumListGrid: {
    padding: 10,
  },
  albumGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  albumGridItem: {
    width: '50%',
    padding: 5,
  },
  albumItem: {
    flex: 1,
    margin: 5,
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    overflow: 'hidden',
  },
  albumThumbContainer: {
    aspectRatio: 1,
    position: 'relative',
  },
  albumThumb: {
    width: '100%',
    height: '100%',
  },
  placeholderThumb: {
    backgroundColor: '#e0e0e0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderIcon: {
    fontSize: 32,
  },
  sharedBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: '#4285F4',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  sharedBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  albumInfo: {
    padding: 10,
  },
  albumTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 3,
  },
  albumCount: {
    fontSize: 12,
    color: '#888',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 15,
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 5,
  },
  emptySubtext: {
    fontSize: 13,
    color: '#999',
  },
  manageButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#fff',
    borderRadius: 8,
  },
  footerButton: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    marginHorizontal: 15,
    marginBottom: 15,
    padding: 15,
    backgroundColor: '#f0f0f0',
    borderRadius: 10,
    alignItems: 'center',
  },
  manageButtonText: {
    fontSize: 15,
    color: '#333',
    fontWeight: '500',
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
    marginBottom: 5,
    textAlign: 'center',
  },
  debugVersionText: {
    fontSize: 11,
    color: '#888',
    textAlign: 'center',
    marginBottom: 10,
    fontFamily: 'monospace',
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
  // アルバム作成モーダル
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: '85%',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 15,
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 10,
    textAlign: 'center',
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 10,
  },
  modalHint: {
    fontSize: 12,
    color: '#888',
    marginBottom: 15,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalCancelButton: {
    backgroundColor: '#f0f0f0',
    marginRight: 10,
  },
  modalCancelText: {
    color: '#666',
    fontSize: 16,
  },
  modalCreateButton: {
    backgroundColor: '#4285F4',
  },
  modalCreateText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  createAlbumButton: {
    backgroundColor: '#4285F4',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginRight: 8,
  },
  createAlbumButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
});
