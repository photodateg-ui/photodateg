/**
 * WebView API ブリッジコンポーネント
 * 
 * 非表示のWebViewを使ってGoogle Photos APIを呼び出す
 * WebViewのCookieを利用するため、React Native側のfetchでは認証が効かない問題を解決
 */

import React, { useRef, useState, useCallback, useImperativeHandle, forwardRef, useEffect } from 'react';
import { View, StyleSheet, ActivityIndicator, Text, Dimensions } from 'react-native';
import { WebView } from 'react-native-webview';

// デバッグモード: trueにするとWebViewが表示される
const DEBUG_WEBVIEW = __DEV__ ? true : false;
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  generateGetAlbumsScript,
  generateGetAlbumPageScript,
  generateRequestId,
  parseAlbumsResponse,
  parseAlbumItemsResponse,
} from '../services/webViewApiClient';

const STORAGE_KEYS = {
  SESSION_DATA: '@photov_session_data',
};

/**
 * APIブリッジコンポーネント
 * 
 * ref経由で以下のメソッドを公開:
 * - getAlbums(pageId?, pageSize?) - アルバム一覧取得
 * - getAlbumItems(albumMediaKey, authKey?, onProgress?) - アルバム内全写真取得
 * - isReady() - セッション有効かどうか
 */
const ApiWebViewBridge = forwardRef(({ onSessionInvalid, onReady, onLoadError }, ref) => {
  const webViewRef = useRef(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const pendingRequests = useRef(new Map());

  // セッションデータを読み込み
  useEffect(() => {
    loadSessionData();
  }, []);

  // WebViewのロードタイムアウト
  useEffect(() => {
    if (!sessionData) return;
    
    const timeout = setTimeout(() => {
      if (!isLoaded && !loadError) {
        console.warn('WebViewのロードがタイムアウトしました');
        const error = 'ネットワーク接続を確認してください（タイムアウト）';
        setLoadError(error);
        onLoadError?.(error);
      }
    }, 15000); // 15秒タイムアウト
    
    return () => clearTimeout(timeout);
  }, [sessionData, isLoaded, loadError, onLoadError]);

  const loadSessionData = async () => {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_DATA);
      console.log('セッションデータ読み込み:', saved ? '存在' : 'なし');
      
      if (saved) {
        const data = JSON.parse(saved);
        // WebAuthScreenの保存形式: { wizData: { SNlM0e, FdrFJe, cfb2h }, savedAt }
        if (data.wizData) {
          const wizData = data.wizData;
          if (wizData.SNlM0e && wizData.FdrFJe && wizData.cfb2h) {
            // 時間ベースの期限チェックは削除（APIエラーで検出する）
            console.log('セッションデータ設定 (wizData形式)');
            setSessionData({
              at: wizData.SNlM0e,
              sid: wizData.FdrFJe,
              bl: wizData.cfb2h,
            });
            setSessionChecked(true);
            return;
          }
        }
        // 新形式 (at, sid, bl直接)
        if (data.at && data.sid && data.bl) {
          console.log('セッションデータ設定 (直接形式)');
          setSessionData(data);
          setSessionChecked(true);
          return;
        }
      }
      // セッションが無効
      console.log('セッションが見つからない');
      setSessionChecked(true);
      // 非同期でコールバックを呼ぶ（マウント完了後）
      setTimeout(() => onSessionInvalid?.(), 0);
    } catch (err) {
      console.error('セッションデータ読み込みエラー:', err);
      setSessionChecked(true);
      setTimeout(() => onSessionInvalid?.(), 0);
    }
  };

  // WebViewからのメッセージを処理
  const handleMessage = useCallback((event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      
      if (message.type === 'API_RESPONSE') {
        const { requestId, success, data, error } = message;
        const pending = pendingRequests.current.get(requestId);
        
        if (pending) {
          pendingRequests.current.delete(requestId);
          
          if (success) {
            pending.resolve(data);
          } else {
            pending.reject(new Error(error || 'Unknown error'));
          }
        }
      }
    } catch (err) {
      console.error('メッセージ処理エラー:', err);
    }
  }, []);

  // WebViewロード開始
  const handleLoadStart = useCallback((syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.log('🌐 WebView Load Start:', {
      url: nativeEvent.url,
      loading: nativeEvent.loading,
    });
  }, []);

  // WebViewロード完了
  const handleLoadEnd = useCallback((syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.log('✅ WebView Load End:', {
      url: nativeEvent.url,
      loading: nativeEvent.loading,
      title: nativeEvent.title,
    });
    // loadErrorがある場合は成功にしない
    if (!loadError) {
      setIsLoaded(true);
      onReady?.();
    }
  }, [onReady, loadError]);

  // WebViewロードエラー
  const handleLoadError = useCallback((syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.error('❌ WebView Load Error:', {
      code: nativeEvent.code,
      description: nativeEvent.description,
      url: nativeEvent.url,
      domain: nativeEvent.domain,
    });
    const errorMessage = nativeEvent.description || nativeEvent.title || 'ページの読み込みに失敗しました';
    setLoadError(errorMessage);
    onLoadError?.(errorMessage);
  }, [onLoadError]);

  // WebView HTTPエラー
  const handleHttpError = useCallback((syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.error('🔴 WebView HTTP Error:', {
      statusCode: nativeEvent.statusCode,
      url: nativeEvent.url,
      description: nativeEvent.description,
    });
  }, []);

  // WebView SSL エラー
  const handleSslError = useCallback((syntheticEvent) => {
    console.error('🔐 WebView SSL Error:', syntheticEvent);
  }, []);

  // APIリクエストを実行
  const executeApiRequest = useCallback((script) => {
    return new Promise((resolve, reject) => {
      if (!webViewRef.current || !isLoaded) {
        reject(new Error('WebViewが準備できていません'));
        return;
      }
      
      // リクエストIDをスクリプトから抽出
      const match = script.match(/requestId = '([^']+)'/);
      if (!match) {
        reject(new Error('リクエストIDが見つかりません'));
        return;
      }
      
      const requestId = match[1];
      
      // タイムアウト設定
      const timeout = setTimeout(() => {
        pendingRequests.current.delete(requestId);
        reject(new Error('リクエストタイムアウト'));
      }, 30000);
      
      // 保留中のリクエストに登録
      pendingRequests.current.set(requestId, {
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      
      // スクリプトを実行
      webViewRef.current.injectJavaScript(script);
    });
  }, [isLoaded]);

  // 公開APIメソッド
  useImperativeHandle(ref, () => ({
    /**
     * セッションが有効か確認
     */
    isReady: () => isLoaded && sessionData != null && !loadError,
    
    /**
     * ロードエラーを取得
     */
    getLoadError: () => loadError,
    
    /**
     * WebViewをリロード（エラー回復用）
     */
    reload: () => {
      setLoadError(null);
      setIsLoaded(false);
      webViewRef.current?.reload();
    },
    
    /**
     * アルバム一覧を取得
     */
    getAlbums: async (pageId = null, pageSize = 100) => {
      if (!sessionData) {
        throw new Error('セッションが無効です。再度ログインしてください。');
      }
      if (loadError) {
        throw new Error(loadError);
      }
      
      const requestId = generateRequestId();
      const script = generateGetAlbumsScript(requestId, sessionData, pageId, pageSize);
      const data = await executeApiRequest(script);
      return parseAlbumsResponse(data);
    },
    
    /**
     * アルバム内の全写真を取得（自動ページネーション）
     */
    getAllAlbumItems: async (albumMediaKey, authKey = null, onProgress = null) => {
      if (!sessionData) {
        throw new Error('セッションが無効です。再度ログインしてください。');
      }
      if (loadError) {
        throw new Error(loadError);
      }
      
      const allItems = [];
      let pageId = null;
      let totalCount = 0;
      
      do {
        const requestId = generateRequestId();
        const script = generateGetAlbumPageScript(requestId, sessionData, albumMediaKey, pageId, authKey);
        const data = await executeApiRequest(script);
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
    },
    
    /**
     * セッションデータを更新
     */
    updateSessionData: async (newSessionData) => {
      setSessionData(newSessionData);
      await AsyncStorage.setItem(STORAGE_KEYS.SESSION_DATA, JSON.stringify(newSessionData));
    },

    /**
     * セッションをクリア
     */
    clearSession: async () => {
      setSessionData(null);
      await AsyncStorage.removeItem(STORAGE_KEYS.SESSION_DATA);
    },
  }), [isLoaded, sessionData, loadError, executeApiRequest]);

  // セッションチェック中
  if (!sessionChecked) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color="#4285F4" />
        <Text style={styles.loadingText}>セッションを確認中...</Text>
      </View>
    );
  }
  
  // セッションがない場合は何も表示しない（onSessionInvalidで遷移する）
  if (!sessionData) {
    return null;
  }

  return (
    <View style={DEBUG_WEBVIEW ? styles.debugContainer : styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://photos.google.com/' }}
        style={DEBUG_WEBVIEW ? styles.debugWebView : styles.webView}
        onMessage={handleMessage}
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
        onError={handleLoadError}
        onHttpError={handleHttpError}
        onSslError={handleSslError}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        thirdPartyCookiesEnabled={true}
        sharedCookiesEnabled={true}
        incognito={false}
        cacheEnabled={true}
        // iOS固有の設定
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        // ユーザーエージェントを設定（ヘッドレス検出回避）
        userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        // 非表示WebViewのロードを確実にする
        startInLoadingState={true}
        renderLoading={() => DEBUG_WEBVIEW ? <ActivityIndicator size="large" color="#4285F4" style={styles.loadingIndicator} /> : null}
      />
      {DEBUG_WEBVIEW && loadError && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorText}>Error: {loadError}</Text>
        </View>
      )}
      {DEBUG_WEBVIEW && (
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>
            {isLoaded ? '✅ Loaded' : '⏳ Loading...'} | Session: {sessionData ? '✓' : '✗'}
          </Text>
        </View>
      )}
    </View>
  );
});

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

const styles = StyleSheet.create({
  // 本番用（非表示）
  container: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
  webView: {
    width: 1,
    height: 1,
  },
  // デバッグ用（表示）
  debugContainer: {
    position: 'absolute',
    top: 100,
    left: 20,
    right: 20,
    height: screenHeight * 0.5,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#4285F4',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
    zIndex: 1000,
  },
  debugWebView: {
    flex: 1,
    backgroundColor: '#fff',
  },
  loadingIndicator: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginLeft: -20,
    marginTop: -20,
  },
  errorOverlay: {
    position: 'absolute',
    bottom: 40,
    left: 10,
    right: 10,
    padding: 10,
    backgroundColor: 'rgba(255, 0, 0, 0.8)',
    borderRadius: 8,
  },
  errorText: {
    color: '#fff',
    fontSize: 12,
    textAlign: 'center',
  },
  statusBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    padding: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  statusText: {
    color: '#fff',
    fontSize: 11,
    textAlign: 'center',
  },
  loadingContainer: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  loadingText: {
    fontSize: 10,
  },
});

export default ApiWebViewBridge;
