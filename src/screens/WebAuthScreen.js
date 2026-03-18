import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sessionManager } from '../services/googlePhotosWebApi';
import {
  generateGetAlbumsScript,
  parseAlbumsResponse,
  generateRequestId,
} from '../services/webViewApiClient';

const STORAGE_KEYS = {
  SESSION_DATA: '@photov_session_data',
  SELECTED_ALBUM: '@photov_selected_album',
};

/**
 * WebViewを使用してGoogleフォトにログインし、
 * セッション情報を抽出→アルバム一覧を取得するスクリーン
 * 
 * 重要: 同じWebViewインスタンスでログインとAPI呼び出しを行うことで
 * Cookie共有の問題を解決
 */
export default function WebAuthScreen({ navigation, route }) {
  const webViewRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState('ログインしてください...');
  const [extractionAttempts, setExtractionAttempts] = useState(0);
  const [sessionData, setSessionData] = useState(null);
  const [isLoadingAlbums, setIsLoadingAlbums] = useState(false);
  const [isOnPhotosPage, setIsOnPhotosPage] = useState(false);
  const pendingAlbumsRequest = useRef(null);
  
  // Googleアカウントのログインページに直接ナビゲート
  const targetUrl = route?.params?.targetUrl || 'https://accounts.google.com/ServiceLogin?service=lso&passive=true&continue=https%3A%2F%2Fphotos.google.com%2F';

  // 保存済みセッションを確認
  useEffect(() => {
    checkSavedSession();
  }, []);

  const checkSavedSession = async () => {
    try {
      const savedSession = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_DATA);
      if (savedSession) {
        const sessionDataStored = JSON.parse(savedSession);
        // セッションが24時間以内なら再利用
        if (sessionDataStored.savedAt && Date.now() - sessionDataStored.savedAt < 24 * 60 * 60 * 1000) {
          console.log('保存済みセッションを使用');
          if (sessionManager.setFromWizData(sessionDataStored.wizData)) {
            // 保存済みアルバムがあれば直接Home画面へ
            const savedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
            if (savedAlbum) {
              const album = JSON.parse(savedAlbum);
              navigation.replace('HomeWeb', {
                albumMediaKey: album.mediaKey,
                albumTitle: album.title,
                authKey: album.authKey,
                apiAlbumId: album.apiAlbumId,
                isFromAutoLoad: true,
              });
            } else {
              // セッションはあるがアルバム未選択 → セッションを設定してアルバム取得
              const sd = {
                at: sessionDataStored.wizData.SNlM0e,
                sid: sessionDataStored.wizData.FdrFJe,
                bl: sessionDataStored.wizData.cfb2h,
              };
              setSessionData(sd);
              // WebViewがロードされるのを待ってからアルバム取得
            }
            return;
          }
        }
      }
    } catch (error) {
      console.warn('セッション確認エラー:', error);
    }
  };

  /**
   * WebView検出回避スクリプト（ページ読み込み前に実行）
   */
  const antiDetectionScript = `
    // ReactNativeWebViewを別名で保存してから隠す
    window.__rnwv = window.ReactNativeWebView;
    
    // ReactNativeWebViewをenumerableでなくする（検出回避）
    Object.defineProperty(window, 'ReactNativeWebView', {
      value: window.__rnwv,
      writable: false,
      enumerable: false,
      configurable: false
    });
    
    // WebView固有のプロパティを隠す
    Object.defineProperty(navigator, 'standalone', {
      get: function() { return false; }
    });
    
    // 一般的なWebView検出を回避
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      delete window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    }
    
    true;
  `;

  /**
   * WIZ_global_data を抽出するJavaScript
   */
  const extractionScript = `
    (function() {
      try {
        // WIZ_global_data を探す
        if (typeof WIZ_global_data !== 'undefined') {
          const data = {
            SNlM0e: WIZ_global_data.SNlM0e,
            FdrFJe: WIZ_global_data.FdrFJe,
            cfb2h: WIZ_global_data.cfb2h,
            qwAQke: WIZ_global_data.qwAQke,
          };
          
          // 全て揃っているか確認
          if (data.SNlM0e && data.FdrFJe && data.cfb2h) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'SESSION_DATA',
              data: data,
              url: window.location.href,
            }));
            return;
          }
        }
        
        // window.AF_initDataCallback からも探してみる
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent || '';
          
          // SNlM0e を探す
          const atMatch = text.match(/SNlM0e['"\\s]*:['"\\s]*["']([^"']+)["']/);
          const sidMatch = text.match(/FdrFJe['"\\s]*:['"\\s]*["'](-?\\d+)["']/);
          const blMatch = text.match(/cfb2h['"\\s]*:['"\\s]*["']([^"']+)["']/);
          
          if (atMatch && sidMatch && blMatch) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'SESSION_DATA',
              data: {
                SNlM0e: atMatch[1],
                FdrFJe: sidMatch[1],
                cfb2h: blMatch[1],
              },
              url: window.location.href,
            }));
            return;
          }
        }
        
        // 見つからなかった
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'EXTRACTION_FAILED',
          url: window.location.href,
          hasWizData: typeof WIZ_global_data !== 'undefined',
        }));
      } catch (error) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'ERROR',
          message: error.message,
        }));
      }
    })();
    true;
  `;

  /**
   * アルバム一覧を取得
   */
  const fetchAlbumsRef = useRef(false);  // 重複呼び出し防止
  const fetchAlbums = useCallback(async (sd) => {
    if (!webViewRef.current || !sd) {
      console.error('WebViewまたはセッションデータがありません');
      return;
    }
    
    // 重複呼び出し防止
    if (fetchAlbumsRef.current) {
      console.log('fetchAlbums already in progress, skipping');
      return;
    }
    fetchAlbumsRef.current = true;

    setIsLoadingAlbums(true);
    setStatusMessage('アルバム一覧を取得中...');

    const requestId = generateRequestId();
    const script = generateGetAlbumsScript(requestId, sd, null, 100);

    // Promise を作成して保存
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingAlbumsRequest.current = null;
        reject(new Error('アルバム取得タイムアウト'));
      }, 30000);

      pendingAlbumsRequest.current = {
        requestId,
        resolve: (data) => {
          clearTimeout(timeout);
          pendingAlbumsRequest.current = null;
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timeout);
          pendingAlbumsRequest.current = null;
          reject(error);
        },
      };
    });

    // スクリプトを実行
    webViewRef.current.injectJavaScript(script);

    try {
      const data = await promise;
      const parsed = parseAlbumsResponse(data);
      
      // 共有アルバムを優先的に上に表示
      const sortedAlbums = [...parsed.items].sort((a, b) => {
        if (a.isShared && !b.isShared) return -1;
        if (!a.isShared && b.isShared) return 1;
        return (b.modifiedTimestamp || 0) - (a.modifiedTimestamp || 0);
      });

      console.log(`アルバム ${sortedAlbums.length} 件取得`);
      
      // AlbumSelectWebScreenへ遷移（アルバムデータ付き）
      navigation.replace('AlbumSelectWeb', {
        albums: sortedAlbums,
        sessionData: sd,
      });
    } catch (error) {
      console.error('アルバム取得エラー:', error);
      fetchAlbumsRef.current = false;  // リセットして再試行可能に
      setIsLoadingAlbums(false);
      setStatusMessage('アルバム取得に失敗しました');
      Alert.alert(
        'エラー',
        'アルバムの取得に失敗しました。再度お試しください。',
        [
          { text: '再試行', onPress: () => fetchAlbums(sd) },
          { text: 'キャンセル', onPress: () => navigation.goBack() },
        ]
      );
    }
  }, [navigation]);

  /**
   * WebViewからのメッセージを処理
   */
  const handleMessage = useCallback(async (event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      console.log('WebView message:', message.type);

      switch (message.type) {
        case 'SESSION_DATA':
          // 既に処理中なら重複をスキップ
          if (fetchAlbumsRef.current || isLoadingAlbums) {
            console.log('SESSION_DATA received but already processing, skipping');
            return;
          }
          console.log('セッション情報を取得しました', message.url);
          setStatusMessage('セッション情報を保存中...');
          
          // セッションマネージャーに設定
          if (sessionManager.setFromWizData(message.data)) {
            // AsyncStorageに保存
            await AsyncStorage.setItem(STORAGE_KEYS.SESSION_DATA, JSON.stringify({
              wizData: message.data,
              savedAt: Date.now(),
            }));
            
            // セッションデータを設定
            const sd = {
              at: message.data.SNlM0e,
              sid: message.data.FdrFJe,
              bl: message.data.cfb2h,
            };
            setSessionData(sd);
            
            // 保存済みアルバムを確認
            const savedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
            if (savedAlbum) {
              const album = JSON.parse(savedAlbum);
              navigation.replace('HomeWeb', {
                albumMediaKey: album.mediaKey,
                albumTitle: album.title,
                authKey: album.authKey,
                apiAlbumId: album.apiAlbumId,
                isFromAutoLoad: true,
              });
            } else {
              // photos.google.com にいることを確認してからアルバム取得
              const currentUrl = message.url || '';
              if (currentUrl.includes('photos.google.com') && !currentUrl.includes('accounts.google.com')) {
                fetchAlbums(sd);
              } else {
                // photos.google.com への遷移を待つ
                setStatusMessage('Googleフォトへ移動中...');
                console.log('photos.google.comへの遷移を待っています。現在:', currentUrl);
              }
            }
          } else {
            Alert.alert('エラー', 'セッション情報が不完全です。再度ログインしてください。');
          }
          break;

        case 'API_RESPONSE':
          // アルバム取得のレスポンス
          if (pendingAlbumsRequest.current && 
              pendingAlbumsRequest.current.requestId === message.requestId) {
            if (message.success) {
              pendingAlbumsRequest.current.resolve(message.data);
            } else {
              pendingAlbumsRequest.current.reject(new Error(message.error || 'Unknown error'));
            }
          }
          break;

        case 'EXTRACTION_FAILED':
          console.log('セッション抽出失敗:', message);
          setExtractionAttempts(prev => prev + 1);
          
          // ログインページかどうか確認
          if (message.url.includes('accounts.google.com')) {
            setStatusMessage('Googleアカウントでログインしてください');
          } else if (extractionAttempts < 5) {
            // 少し待って再試行
            setTimeout(() => {
              webViewRef.current?.injectJavaScript(extractionScript);
            }, 1000);
          } else {
            setStatusMessage('セッション取得に失敗しました。ページを更新してください。');
          }
          break;

        case 'ERROR':
          console.error('WebView error:', message.message);
          break;
      }
    } catch (error) {
      console.error('メッセージ処理エラー:', error);
    }
  }, [navigation, extractionAttempts, fetchAlbums]);

  /**
   * ページ読み込み完了時
   */
  const handleLoadEnd = useCallback((syntheticEvent) => {
    setIsLoading(false);
    
    // 現在のURLを取得
    const currentUrl = syntheticEvent?.nativeEvent?.url || '';
    console.log('handleLoadEnd URL:', currentUrl);
    
    // ログインページにいる場合はアルバム取得を試みない
    if (currentUrl.includes('accounts.google.com')) {
      setStatusMessage('Googleアカウントでログインしてください');
      return;
    }
    
    // photos.google.com にいる場合のみ処理を続行
    if (!currentUrl.includes('photos.google.com')) {
      return;
    }
    
    // すでにセッションデータがある（保存済みセッションから）場合、アルバム取得
    if (sessionData && !isLoadingAlbums) {
      fetchAlbums(sessionData);
      return;
    }
    
    // 少し待ってからセッション抽出を試行
    setTimeout(() => {
      webViewRef.current?.injectJavaScript(extractionScript);
    }, 500);
  }, [sessionData, isLoadingAlbums, fetchAlbums]);

  /**
   * URLが変更されたとき
   */
  const handleNavigationStateChange = useCallback((navState) => {
    console.log('Navigation:', navState.url);
    
    const onPhotos = navState.url.includes('photos.google.com') && !navState.url.includes('accounts.google.com');
    setIsOnPhotosPage(onPhotos);
    
    if (onPhotos) {
      if (!sessionData && !isLoadingAlbums) {
        setStatusMessage('セッション情報を取得中...');
      } else if (sessionData && !isLoadingAlbums) {
        // photos.google.com に到達し、セッションもある場合はアルバム取得
        console.log('photos.google.com に到達、アルバム取得開始');
        fetchAlbums(sessionData);
      }
    } else if (navState.url.includes('accounts.google.com')) {
      setStatusMessage('Googleアカウントでログインしてください');
    }
  }, [sessionData, isLoadingAlbums, fetchAlbums]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity 
          style={styles.cancelButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.cancelButtonText}>キャンセル</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Googleフォトにログイン</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.statusBar}>
        <Text style={styles.statusText}>{statusMessage}</Text>
      </View>

      <WebView
        ref={webViewRef}
        source={{ uri: targetUrl }}
        style={styles.webview}
        onLoadEnd={handleLoadEnd}
        onMessage={handleMessage}
        onNavigationStateChange={handleNavigationStateChange}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        incognito={false}
        cacheEnabled={true}
        userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        injectedJavaScriptBeforeContentLoaded={antiDetectionScript}
      />

      {(isLoading || isLoadingAlbums) && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#4285F4" />
          <Text style={styles.loadingText}>
            {isLoadingAlbums ? 'アルバムを取得中...' : '読み込み中...'}
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  cancelButton: {
    padding: 5,
  },
  cancelButtonText: {
    color: '#4285F4',
    fontSize: 16,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#333',
  },
  headerSpacer: {
    width: 70,
  },
  statusBar: {
    backgroundColor: '#f5f5f5',
    paddingVertical: 8,
    paddingHorizontal: 15,
  },
  statusText: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
  },
  webview: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 10,
    fontSize: 14,
    color: '#666',
  },
});
