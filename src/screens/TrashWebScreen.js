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
import {
  getPhotoUrl,
  restoreFromTrash,
  getTrashItems,
  sessionManager,
} from '../services/googlePhotosWebApi';
import { addDebugLog } from '../services/googleAuthService';

const BUILD_VERSION = 'v0.3.94';
const SCREEN_WIDTH = Dimensions.get('window').width;
const NUM_COLUMNS = 3;
const ITEM_SIZE = SCREEN_WIDTH / NUM_COLUMNS;

const STORAGE_KEYS = {
  SESSION_DATA: '@photov_session_data',
};

/**
 * ゴミ箱画面
 * 
 * 削除された写真の一覧を表示し、復元機能を提供
 */
export default function TrashWebScreen({ navigation, route }) {
  const initialSessionData = route?.params?.sessionData || null;

  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [sessionData, setSessionData] = useState(initialSessionData);
  const [isWebViewReady, setIsWebViewReady] = useState(false);
  const [webViewKey, setWebViewKey] = useState(0);
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const webViewRef = useRef(null);
  const pendingRequest = useRef(null);

  // セッションデータを読み込む
  useEffect(() => {
    if (!sessionData) {
      loadSessionData();
    } else {
      // API方式は一旦無効化、WebViewで取得
      // loadTrashItemsViaApi();
      addDebugLog('TRASH', 'Using WebView only (API disabled)');
    }
  }, [sessionData]);

  const loadSessionData = async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_DATA);
      if (stored) {
        const parsed = JSON.parse(stored);
        // sessionManagerを初期化
        if (parsed.wizData) {
          sessionManager.setFromWizData(parsed.wizData);
        }
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

  // APIでゴミ箱アイテムを取得
  const loadTrashItemsViaApi = async () => {
    addDebugLog('TRASH', 'Attempting to load trash items via API');
    addDebugLog('TRASH', `sessionManager.isValid: ${sessionManager.isValid}`);
    addDebugLog('TRASH', `sessionManager.at: ${sessionManager.at ? 'exists' : 'missing'}`);
    addDebugLog('TRASH', `sessionManager.sid: ${sessionManager.sid ? 'exists' : 'missing'}`);
    
    if (!sessionManager.isValid) {
      addDebugLog('TRASH', 'Session not valid, falling back to WebView');
      // WebViewでのフォールバックは既存のロジックに任せる
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      
      addDebugLog('TRASH', 'Calling getTrashItems API...');
      const result = await getTrashItems(null, 100);
      addDebugLog('TRASH', `API result: ${JSON.stringify(result).substring(0, 300)}`);
      
      if (result.items && result.items.length > 0) {
        setItems(result.items);
        setIsLoading(false);
        addDebugLog('TRASH', `SUCCESS: Loaded ${result.items.length} trash items via API`);
      } else {
        addDebugLog('TRASH', 'No items from API (trash may be empty)');
        // 0件でも成功とみなす（本当に空の可能性）
        setItems([]);
        setIsLoading(false);
      }
    } catch (err) {
      addDebugLog('TRASH', `API error: ${err.message}`);
      // APIが失敗したらWebViewにフォールバック
      addDebugLog('TRASH', 'Falling back to WebView...');
      // isLoadingはtrueのままにして、WebViewに任せる
    }
  };

  // ゴミ箱一覧取得用のスクリプト生成
  const generateGetTrashScript = useCallback(() => {
    const requestId = `trash_${Date.now()}`;
    pendingRequest.current = requestId;

    return `
      (function() {
        const requestId = '${requestId}';
        
        try {
          let trashItems = [];
          let debugInfo = { imgCount: 0, bgCount: 0, dataCount: 0, initDataItems: 0 };
          
          // 方法1: 実際の画像要素から取得
          const allImages = document.querySelectorAll('img[src*="googleusercontent.com"]');
          debugInfo.imgCount = allImages.length;
          for (const img of allImages) {
            const src = img.src;
            const match = src.match(/\\/([A-Za-z0-9_-]{30,})(?:=|$)/);
            if (match) {
              const mediaKey = match[1];
              if (mediaKey.startsWith('AF1Qip') && !trashItems.find(item => item.mediaKey === mediaKey)) {
                trashItems.push({
                  id: 'img_' + trashItems.length,
                  mediaKey: mediaKey,
                  thumb: 'https://lh3.googleusercontent.com/' + mediaKey + '=w256-h256-c',
                });
              }
            }
          }
          
          // 方法2: 背景画像から取得
          if (trashItems.length === 0) {
            const allDivs = document.querySelectorAll('div[style*="background-image"]');
            debugInfo.bgCount = allDivs.length;
            for (const div of allDivs) {
              const style = div.getAttribute('style') || '';
              const match = style.match(/googleusercontent\\.com\\/([A-Za-z0-9_-]{30,})/);
              if (match) {
                const mediaKey = match[1];
                if (mediaKey.startsWith('AF1Qip') && !trashItems.find(item => item.mediaKey === mediaKey)) {
                  trashItems.push({
                    id: 'bg_' + trashItems.length,
                    mediaKey: mediaKey,
                    thumb: 'https://lh3.googleusercontent.com/' + mediaKey + '=w256-h256-c',
                  });
                }
              }
            }
          }
          
          // 方法3: ページデータからゴミ箱アイテムを抽出
          if (trashItems.length === 0) {
            const scripts = document.querySelectorAll('script');
            let af1qipCount = 0;
            let sampleData = '';
            
            for (const script of scripts) {
              const text = script.textContent || '';
              
              if (text.includes('AF1Qip')) {
                // AF1Qipの出現回数をカウント
                const matches = text.match(/AF1Qip/g);
                if (matches) af1qipCount += matches.length;
                
                // サンプル取得（デバッグ用）- 500文字
                if (!sampleData) {
                  const idx = text.indexOf('AF1Qip');
                  sampleData = text.substring(Math.max(0, idx - 20), idx + 500);
                }
                
                // パターン1: ["AF1Qip...",["https://... 形式
                const pattern1 = /\\["(AF1Qip[A-Za-z0-9_-]+)",\\s*\\["(https:\\/\\/[^"]+)"/g;
                let m1;
                while ((m1 = pattern1.exec(text)) !== null) {
                  const mediaKey = m1[1];
                  const thumbUrl = m1[2];
                  if (!trashItems.find(item => item.mediaKey === mediaKey)) {
                    debugInfo.initDataItems++;
                    trashItems.push({
                      id: 'p1_' + trashItems.length,
                      mediaKey: mediaKey,
                      thumb: thumbUrl.includes('=') ? thumbUrl : thumbUrl + '=w256-h256-c',
                    });
                  }
                }
                
                // パターン2: [["AF1Qip..."],["https://... 形式（配列がネスト）
                const pattern2 = /\\[\\["(AF1Qip[A-Za-z0-9_-]+)"\\],\\s*\\["(https:\\/\\/[^"]+)"/g;
                let m2;
                while ((m2 = pattern2.exec(text)) !== null) {
                  const mediaKey = m2[1];
                  const thumbUrl = m2[2];
                  if (!trashItems.find(item => item.mediaKey === mediaKey)) {
                    debugInfo.initDataItems++;
                    trashItems.push({
                      id: 'p2_' + trashItems.length,
                      mediaKey: mediaKey,
                      thumb: thumbUrl.includes('=') ? thumbUrl : thumbUrl + '=w256-h256-c',
                    });
                  }
                }
                
                // パターン3: [[["AF1Qip... 形式（3重ネスト）- サムネイルは後続要素
                const pattern3 = /\\[\\[\\["(AF1Qip[A-Za-z0-9_-]+)"[^\\]]*\\][^\\]]*\\],\\s*\\["(https:\\/\\/[^"]+)"/g;
                let m3;
                while ((m3 = pattern3.exec(text)) !== null) {
                  const mediaKey = m3[1];
                  const thumbUrl = m3[2];
                  if (!trashItems.find(item => item.mediaKey === mediaKey)) {
                    debugInfo.initDataItems++;
                    trashItems.push({
                      id: 'p3_' + trashItems.length,
                      mediaKey: mediaKey,
                      thumb: thumbUrl.includes('=') ? thumbUrl : thumbUrl + '=w256-h256-c',
                    });
                  }
                }
              }
            }
            
            debugInfo.af1qipCount = af1qipCount;
            debugInfo.af1qipSample = sampleData.substring(0, 400);
          }
          
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'TRASH_RESPONSE',
            requestId: requestId,
            items: trashItems,
            debug: {
              method: trashItems.length > 0 ? (trashItems[0].id.split('_')[0]) : 'none',
              totalFound: trashItems.length,
              url: window.location.href,
              hasWizData: !!window.WIZ_global_data,
              ...debugInfo,
            }
          }));
        } catch (e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'TRASH_ERROR',
            requestId: requestId,
            error: e.message
          }));
        }
      })();
      true;
    `;
  }, []);

  // ゴミ箱レスポンスをパース
  const parseTrashResponse = useCallback((rawText) => {
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
        console.log('No valid JSON found in trash response');
        return [];
      }

      // ゴミ箱アイテムをパース
      // 構造: [null, [[item1], [item2], ...]]
      const itemsData = jsonData?.[1] || [];
      
      const items = itemsData.map((itemData, index) => {
        if (!itemData) return null;

        const mediaKey = itemData?.[0];
        const ownerId = itemData?.[1];
        const timestampData = itemData?.[7];
        const timestamp = timestampData?.[1] || null;
        const dedupKey = itemData?.[3] || null;

        if (!mediaKey) return null;

        return {
          id: `trash_${index}_${mediaKey}`,
          mediaKey,
          ownerId,
          timestamp,
          dedupKey,
          thumb: `https://lh3.googleusercontent.com/${mediaKey}`,
        };
      }).filter(Boolean);

      console.log(`📦 Parsed ${items.length} trash items`);
      return items;
    } catch (error) {
      console.error('Failed to parse trash response:', error);
      return [];
    }
  }, []);

  // WebViewメッセージハンドラ
  const handleWebViewMessage = useCallback((event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      console.log('📨 WebView message:', message.type, message.debug);
      addDebugLog('TRASH', `WebView message: ${message.type} ${JSON.stringify(message.debug || message.error || {}).substring(0, 200)}`);

      if (message.type === 'TRASH_SCRIPT_START') {
        addDebugLog('TRASH', `Script started, URL: ${message.url}`);
        return;
      }

      if (message.type === 'TRASH_RESPONSE') {
        if (message.requestId !== pendingRequest.current) {
          console.log('Ignoring stale response');
          return;
        }

        // 新しい形式: message.itemsを直接使用
        const items = message.items || [];
        console.log(`🗑️ Got ${items.length} trash items`);
        
        setItems(items);
        setIsLoading(false);
        setIsRefreshing(false);
        setError(items.length === 0 ? null : null);
      } else if (message.type === 'TRASH_ERROR') {
        console.error('Trash error:', message.error);
        setError(message.error);
        setIsLoading(false);
        setIsRefreshing(false);
      }
    } catch (error) {
      console.error('Failed to handle WebView message:', error);
    }
  }, []);

  // WebView準備完了時
  const handleWebViewLoad = useCallback(() => {
    console.log('📱 Trash WebView loaded');
    addDebugLog('TRASH', 'WebView onLoad fired');
    setIsWebViewReady(true);
    
    // ゴミ箱一覧を取得（ページの読み込みを待つ）
    setTimeout(() => {
      addDebugLog('TRASH', 'Injecting trash script...');
      const script = generateGetTrashScript();
      if (script && webViewRef.current) {
        webViewRef.current.injectJavaScript(script);
        addDebugLog('TRASH', 'Script injected');
      } else {
        addDebugLog('TRASH', `Script injection failed: script=${!!script}, webViewRef=${!!webViewRef.current}`);
      }
    }, 1500);
  }, [generateGetTrashScript]);

  // WebViewエラー時
  const handleWebViewError = useCallback((event) => {
    const { nativeEvent } = event;
    addDebugLog('TRASH', `WebView error: ${nativeEvent.description || JSON.stringify(nativeEvent)}`);
    setError('ゴミ箱の読み込みに失敗しました');
    setIsLoading(false);
  }, []);

  // リフレッシュ
  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    addDebugLog('TRASH', 'onRefresh called');
    
    // まずAPIを試す
    if (sessionManager.isValid) {
      try {
        addDebugLog('TRASH', 'Refreshing via API...');
        const result = await getTrashItems(null, 100);
        if (result.items) {
          setItems(result.items);
          setIsRefreshing(false);
          addDebugLog('TRASH', `Refreshed ${result.items.length} trash items via API`);
          return;
        }
      } catch (err) {
        addDebugLog('TRASH', `Refresh API error: ${err.message}`);
      }
    }
    
    // APIが失敗したらWebViewをリロード
    addDebugLog('TRASH', 'Falling back to WebView refresh');
    setWebViewKey(prev => prev + 1);
    setIsWebViewReady(false);
  }, []);

  // 選択モード切り替え
  const toggleSelectionMode = useCallback(() => {
    setIsSelectionMode(!isSelectionMode);
    setSelectedItems(new Set());
  }, [isSelectionMode]);

  // アイテム選択
  const toggleItemSelection = useCallback((item) => {
    if (!item.dedupKey) {
      Alert.alert('エラー', 'この写真は復元できません（dedupKeyがありません）');
      return;
    }

    setSelectedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(item.dedupKey)) {
        newSet.delete(item.dedupKey);
      } else {
        newSet.add(item.dedupKey);
      }
      return newSet;
    });
  }, []);

  // 選択した写真を復元
  const restoreSelectedItems = useCallback(async () => {
    if (selectedItems.size === 0) return;

    Alert.alert(
      '復元確認',
      `${selectedItems.size}枚の写真を復元しますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '復元',
          onPress: async () => {
            setIsRestoring(true);
            try {
              const dedupKeys = Array.from(selectedItems);
              await restoreFromTrash(dedupKeys);
              
              // 復元した写真をリストから削除
              setItems(prev => prev.filter(item => !selectedItems.has(item.dedupKey)));
              setSelectedItems(new Set());
              setIsSelectionMode(false);
              
              Alert.alert('完了', '写真を復元しました');
            } catch (error) {
              console.error('Restore failed:', error);
              Alert.alert('エラー', '復元に失敗しました: ' + error.message);
            } finally {
              setIsRestoring(false);
            }
          },
        },
      ]
    );
  }, [selectedItems]);

  // 写真アイテムのレンダリング
  const renderItem = useCallback(({ item }) => {
    const isSelected = selectedItems.has(item.dedupKey);
    const thumbUrl = getPhotoUrl(item.thumb, 200, 200, true);

    return (
      <TouchableOpacity
        style={[
          styles.imageContainer,
          isSelectionMode && isSelected && styles.imageContainerSelected,
        ]}
        onPress={() => {
          if (isSelectionMode) {
            toggleItemSelection(item);
          }
        }}
        onLongPress={() => {
          if (!isSelectionMode) {
            setIsSelectionMode(true);
            toggleItemSelection(item);
          }
        }}
        activeOpacity={0.7}
      >
        <Image
          source={{ uri: thumbUrl }}
          style={styles.thumbnail}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
        {isSelectionMode && (
          <View style={[
            styles.selectionIndicator,
            isSelected && styles.selectionIndicatorSelected,
          ]}>
            {isSelected && <Text style={styles.checkmark}>✓</Text>}
          </View>
        )}
      </TouchableOpacity>
    );
  }, [isSelectionMode, selectedItems, toggleItemSelection]);

  // ヘッダー
  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
        <Text style={styles.backButtonText}>← 戻る</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>ゴミ箱</Text>
      <View style={styles.headerRight}>
        {isSelectionMode ? (
          <TouchableOpacity onPress={toggleSelectionMode} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>キャンセル</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={toggleSelectionMode} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>選択</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  // ローディング中のUIは下で条件分岐で表示（WebViewは1つに統一）

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
      
      {isLoading && !isRefreshing ? (
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color="#4285F4" />
          <Text style={styles.loadingText}>ゴミ箱を読み込み中...</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.centerContent}>
          <Text style={styles.emptyText}>ゴミ箱は空です</Text>
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

      {/* 選択モード時のフッター */}
      {isSelectionMode && selectedItems.size > 0 && (
        <View style={styles.selectionFooter}>
          <Text style={styles.selectionCount}>{selectedItems.size}枚選択中</Text>
          <TouchableOpacity
            onPress={restoreSelectedItems}
            style={styles.restoreButton}
            disabled={isRestoring}
          >
            {isRestoring ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.restoreButtonText}>復元</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* リフレッシュ用WebView */}
      {sessionData && (
        <View style={styles.offscreenWebViewContainer}>
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={{ uri: 'https://photos.google.com/trash' }}
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
    alignItems: 'flex-end',
  },
  headerButton: {
    padding: 8,
  },
  headerButtonText: {
    color: '#4285F4',
    fontSize: 16,
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
  listContent: {
    paddingBottom: 100,
  },
  imageContainer: {
    width: ITEM_SIZE,
    height: ITEM_SIZE,
    padding: 1,
  },
  imageContainerSelected: {
    backgroundColor: 'rgba(66, 133, 244, 0.3)',
  },
  thumbnail: {
    width: '100%',
    height: '100%',
    backgroundColor: '#222',
  },
  selectionIndicator: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderWidth: 2,
    borderColor: '#fff',
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
  selectionFooter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: '#222',
    borderTopWidth: 1,
    borderTopColor: '#444',
  },
  selectionCount: {
    color: '#fff',
    fontSize: 16,
  },
  restoreButton: {
    backgroundColor: '#4285F4',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  restoreButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
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
