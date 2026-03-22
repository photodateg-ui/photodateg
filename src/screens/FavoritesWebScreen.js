import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  RefreshControl,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getPhotoUrl } from '../services/googlePhotosWebApi';

const BUILD_VERSION = 'v0.3.98';
const SCREEN_WIDTH = Dimensions.get('window').width;
const NUM_COLUMNS = 3;
const ITEM_SIZE = SCREEN_WIDTH / NUM_COLUMNS;

// お気に入りページのURL（日本語環境）
const FAVORITES_URL = 'https://photos.google.com/search/%E3%81%8A%E6%B0%97%E3%81%AB%E5%85%A5%E3%82%8A';

const STORAGE_KEYS = {
  SESSION_DATA: '@photov_session_data',
};

/**
 * お気に入り画面
 * 
 * お気に入りに追加された写真の一覧を表示
 */
export default function FavoritesWebScreen({ navigation, route }) {
  const initialSessionData = route?.params?.sessionData || null;

  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [sessionData, setSessionData] = useState(initialSessionData);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [webViewKey, setWebViewKey] = useState(0);

  const webViewRef = useRef(null);
  const pendingRequest = useRef(null);

  // セッションデータを読み込む
  useEffect(() => {
    if (!sessionData) {
      loadSessionData();
    }
  }, []);

  const loadSessionData = async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_DATA);
      if (stored) {
        const parsed = JSON.parse(stored);
        setSessionData(parsed);
      } else {
        setError('セッションデータがありません。再ログインしてください。');
        setIsLoading(false);
      }
    } catch (err) {
      console.error('Failed to load session data:', err);
      setError('セッションの読み込みに失敗しました');
      setIsLoading(false);
    }
  };

  // お気に入り一覧取得用のスクリプト生成
  const generateGetFavoritesScript = useCallback(() => {
    if (!sessionData) return null;

    const requestId = `favorites_${Date.now()}`;
    pendingRequest.current = requestId;

    // EzkLib（アップロード順取得）を使用
    const rpcId = 'EzkLib';

    return `
      (function() {
        const requestId = '${requestId}';
        
        try {
          const at = '${sessionData.at || ''}';
          const bl = '${sessionData.bl || ''}';
          const sid = '${sessionData.sid || ''}';
          
          if (!at || !bl) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'FAVORITES_ERROR',
              requestId: requestId,
              error: 'Missing session data'
            }));
            return;
          }
          
          // お気に入りフィルター用のリクエストデータ
          const requestData = [null, null, null, null, 1, null, null, null, null, null, null, null, null, [2]];
          const reqId = Math.floor(Math.random() * 900000) + 100000;
          
          const formData = new URLSearchParams();
          formData.append('f.req', JSON.stringify([[[
            '${rpcId}',
            JSON.stringify(requestData),
            null,
            'generic'
          ]]]));
          formData.append('at', at);
          
          // source-pathにお気に入りのエンコードされたパスを使用
          const searchPath = encodeURIComponent(window.location.pathname);
          const url = 'https://photos.google.com/_/PhotosUi/data/batchexecute?' +
            'rpcids=${rpcId}&' +
            'source-path=' + searchPath + '&' +
            'f.sid=' + sid + '&' +
            'bl=' + bl + '&' +
            'hl=ja&' +
            'soc-app=165&soc-platform=1&soc-device=1&' +
            '_reqid=' + reqId + '&rt=c';
          
          fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
            body: formData.toString(),
            credentials: 'include',
          })
          .then(response => response.text())
          .then(text => {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'FAVORITES_RESPONSE',
              requestId: requestId,
              data: text
            }));
          })
          .catch(error => {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'FAVORITES_ERROR',
              requestId: requestId,
              error: error.message
            }));
          });
        } catch (e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'FAVORITES_ERROR',
            requestId: requestId,
            error: e.message
          }));
        }
      })();
      true;
    `;
  }, [sessionData]);

  // お気に入りレスポンスをパース
  const parseFavoritesResponse = useCallback((rawText) => {
    try {
      // batchexecuteレスポンスをパース
      const lines = rawText.split('\n');
      let jsonData = null;

      for (const line of lines) {
        if (line.startsWith('[')) {
          try {
            const parsed = JSON.parse(line);
            if (Array.isArray(parsed) && parsed[0]?.[0] === 'wrb.fr') {
              const dataStr = parsed[0]?.[2];
              if (dataStr) {
                jsonData = JSON.parse(dataStr);
                break;
              }
            }
          } catch (e) {
            // 次の行を試す
          }
        }
      }

      if (!jsonData) {
        console.log('No valid JSON found in favorites response');
        return [];
      }

      // お気に入りアイテムをパース
      // 構造: [[[item1], [item2], ...], nextPageToken, ...]
      const itemsData = jsonData?.[0] || [];
      
      const items = itemsData.map((itemData, index) => {
        if (!itemData || !Array.isArray(itemData)) return null;

        const mediaKey = itemData?.[0];
        const thumbData = itemData?.[1];
        const thumb = thumbData?.[0];
        const width = thumbData?.[1];
        const height = thumbData?.[2];
        const timestamp = itemData?.[2];
        const dedupKey = itemData?.[3];

        if (!mediaKey) return null;

        return {
          id: `fav_${index}_${mediaKey}`,
          mediaKey,
          thumb,
          width,
          height,
          timestamp,
          dedupKey,
        };
      }).filter(Boolean);

      console.log(`⭐ Parsed ${items.length} favorite items`);
      return items;
    } catch (error) {
      console.error('Failed to parse favorites response:', error);
      return [];
    }
  }, []);

  // WebViewメッセージハンドラ
  const handleWebViewMessage = useCallback((event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      console.log('📨 WebView message:', message.type);

      if (message.type === 'FAVORITES_RESPONSE') {
        if (message.requestId !== pendingRequest.current) {
          console.log('Ignoring stale response');
          return;
        }

        const parsedItems = parseFavoritesResponse(message.data);
        setItems(parsedItems);
        setIsLoading(false);
        setIsRefreshing(false);
        setError(null);
      } else if (message.type === 'FAVORITES_ERROR') {
        console.error('Favorites error:', message.error);
        setError(message.error);
        setIsLoading(false);
        setIsRefreshing(false);
      }
    } catch (error) {
      console.error('Failed to handle WebView message:', error);
    }
  }, [parseFavoritesResponse]);

  // WebView準備完了時
  const handleWebViewLoad = useCallback(() => {
    console.log('⭐ Favorites WebView loaded');
    setIsWebViewReady(true);
    
    // お気に入り一覧を取得
    setTimeout(() => {
      const script = generateGetFavoritesScript();
      if (script && webViewRef.current) {
        webViewRef.current.injectJavaScript(script);
      }
    }, 500);
  }, [generateGetFavoritesScript]);

  // リフレッシュ
  const onRefresh = useCallback(() => {
    setIsRefreshing(true);
    setWebViewKey(prev => prev + 1);
    setIsWebViewReady(false);
  }, []);

  // 写真アイテムのレンダリング
  const renderItem = useCallback(({ item }) => {
    const thumbUrl = getPhotoUrl(item.thumb, 200, 200, true);

    return (
      <TouchableOpacity
        style={styles.imageContainer}
        onPress={() => {
          // 写真詳細画面に遷移（必要に応じて実装）
        }}
        activeOpacity={0.7}
      >
        <Image
          source={{ uri: thumbUrl }}
          style={styles.thumbnail}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      </TouchableOpacity>
    );
  }, []);

  // ヘッダー
  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
        <Text style={styles.backButtonText}>← 戻る</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>⭐ お気に入り</Text>
      <View style={styles.headerRight} />
    </View>
  );

  // ローディング中
  if (isLoading && !isRefreshing) {
    return (
      <SafeAreaView style={styles.container}>
        {renderHeader()}
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color="#4285F4" />
          <Text style={styles.loadingText}>お気に入りを読み込み中...</Text>
        </View>
        {sessionData && (
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={{ uri: FAVORITES_URL }}
            style={styles.hiddenWebView}
            onLoad={handleWebViewLoad}
            onMessage={handleWebViewMessage}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            sharedCookiesEnabled={true}
            thirdPartyCookiesEnabled={true}
            cacheEnabled={false}
          />
        )}
      </SafeAreaView>
    );
  }

  // エラー
  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        {renderHeader()}
        <View style={styles.centerContent}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={onRefresh} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>再試行</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {renderHeader()}
      
      {items.length === 0 ? (
        <View style={styles.centerContent}>
          <Text style={styles.emptyText}>お気に入りはありません</Text>
          <Text style={styles.emptySubtext}>写真を開いて☆マークをタップすると追加できます</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={NUM_COLUMNS}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              colors={['#4285F4']}
            />
          }
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* リフレッシュ用WebView */}
      {sessionData && (
        <View style={styles.offscreenWebViewContainer}>
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={{ uri: FAVORITES_URL }}
            style={styles.hiddenWebView}
            onLoad={handleWebViewLoad}
            onMessage={handleWebViewMessage}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            sharedCookiesEnabled={true}
            thirdPartyCookiesEnabled={true}
            cacheEnabled={false}
          />
        </View>
      )}

      {/* バージョン表示 */}
      <Text style={styles.versionText}>{BUILD_VERSION}</Text>
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#f8f8f8',
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  backButton: {
    padding: 8,
  },
  backButtonText: {
    color: '#4285F4',
    fontSize: 16,
  },
  headerTitle: {
    color: '#333',
    fontSize: 18,
    fontWeight: 'bold',
  },
  headerRight: {
    minWidth: 80,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#888',
    marginTop: 16,
  },
  errorText: {
    color: '#ff4444',
    marginBottom: 16,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  retryButton: {
    backgroundColor: '#4285F4',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
  emptyText: {
    color: '#888',
    fontSize: 16,
  },
  emptySubtext: {
    color: '#666',
    fontSize: 14,
    marginTop: 8,
  },
  listContent: {
    paddingBottom: 50,
  },
  imageContainer: {
    width: ITEM_SIZE,
    height: ITEM_SIZE,
    padding: 1,
  },
  thumbnail: {
    width: '100%',
    height: '100%',
    backgroundColor: '#222',
  },
  hiddenWebView: {
    width: 1,
    height: 1,
    opacity: 0,
  },
  offscreenWebViewContainer: {
    position: 'absolute',
    top: -9999,
    left: -9999,
    width: 1,
    height: 1,
  },
  versionText: {
    position: 'absolute',
    bottom: 4,
    right: 8,
    color: '#444',
    fontSize: 10,
  },
});
