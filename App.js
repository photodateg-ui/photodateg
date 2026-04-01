import React, { useEffect, useState, useRef, useCallback } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

// OTAチャンネル設定
if (!__DEV__) {
  Updates.setUpdateRequestHeadersOverride({
    'expo-channel-name': 'production'
  });
}
import { sessionManager } from './src/services/googlePhotosWebApi';

// 既存の画面（OAuth方式）
import LoginScreen from './src/screens/LoginScreen';
import AlbumSelectScreen from './src/screens/AlbumSelectScreen';
import HomeScreen from './src/screens/HomeScreen';
import PhotoDetailScreen from './src/screens/PhotoDetailScreen';

// 新しい画面（非公式Web API方式）
import WebAuthScreen from './src/screens/WebAuthScreen';
import AlbumSelectWebScreen from './src/screens/AlbumSelectWebScreen';
import HomeWebScreen from './src/screens/HomeWebScreen';
import PhotoDetailWebScreen from './src/screens/PhotoDetailWebScreen';
import WebManageScreen from './src/screens/WebManageScreen';
import TrashWebScreen from './src/screens/TrashWebScreen';
import FavoritesWebScreen from './src/screens/FavoritesWebScreen';
import AlbumSearchScreen from './src/screens/AlbumSearchScreen';

const Stack = createStackNavigator();

const STORAGE_KEYS = {
  SESSION_DATA: '@photov_session_data',
  SELECTED_ALBUM: '@photov_selected_album',
  AUTH_MODE: '@photov_auth_mode', // 'web' または 'oauth'
};

const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;  // 30日
const SESSION_REFRESH_THRESHOLD = 60 * 60 * 1000;   // 1時間以上経ったらバックグラウンド更新

/**
 * PhotoV - Googleフォトビューア
 * 
 * 認証方式:
 * 1. Web API方式（デフォルト）: WebViewでログインし、非公式APIを使用
 * 2. OAuth方式: 公式Picker APIを使用（制限あり）
 */
export default function App() {
  const [isReady, setIsReady] = useState(false);
  const [initialRoute, setInitialRoute] = useState('Startup');
  const [showBgRefresh, setShowBgRefresh] = useState(false);
  const bgRefreshWebViewRef = useRef(null);

  useEffect(() => {
    checkForOTAUpdate();
    checkSavedSession();
  }, []);

  const checkForOTAUpdate = async () => {
    if (__DEV__) return; // 開発中はスキップ
    
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync(); // 即座に適用して再起動
      }
    } catch (e) {
      console.log('OTA update check failed:', e);
    }
  };

  const checkSavedSession = async () => {
    try {
      // 保存済みセッションを確認
      const savedSession = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_DATA);

      if (savedSession) {
        const sessionData = JSON.parse(savedSession);

        // セッションが30日以内なら再利用
        if (sessionData.savedAt && Date.now() - sessionData.savedAt < SESSION_MAX_AGE) {
          if (sessionManager.setFromWizData(sessionData.wizData)) {
            // 1時間以上経っていればバックグラウンドで更新
            if (Date.now() - sessionData.savedAt > SESSION_REFRESH_THRESHOLD) {
              setShowBgRefresh(true);
            }
            const savedAlbum = await AsyncStorage.getItem(STORAGE_KEYS.SELECTED_ALBUM);
            if (savedAlbum) {
              setInitialRoute('HomeWeb');
            } else {
              setInitialRoute('AlbumSelectWeb');
            }
            setIsReady(true);
            return;
          }
        }
      }

      // セッションなし → スタートアップ画面へ
      setInitialRoute('Startup');
    } catch (error) {
      console.warn('セッション確認エラー:', error);
      setInitialRoute('Startup');
    } finally {
      setIsReady(true);
    }
  };

  const handleBgRefreshMessage = useCallback(async (event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      if (message.type === 'SESSION_DATA' && message.data?.SNlM0e) {
        if (sessionManager.setFromWizData(message.data)) {
          await AsyncStorage.setItem(STORAGE_KEYS.SESSION_DATA, JSON.stringify({
            wizData: message.data,
            savedAt: Date.now(),
          }));
          console.log('[BG_REFRESH] セッション更新成功');
        }
      }
    } catch (e) {
      console.warn('[BG_REFRESH] 更新エラー:', e);
    } finally {
      setShowBgRefresh(false);
    }
  }, []);

  if (!isReady) {
    return null; // スプラッシュ表示中
  }

  return (
    <SafeAreaProvider>
      {showBgRefresh && (
        <BackgroundSessionRefresh
          webViewRef={bgRefreshWebViewRef}
          onMessage={handleBgRefreshMessage}
        />
      )}
      <NavigationContainer>
        <StatusBar style="auto" />
        <Stack.Navigator
        initialRouteName={initialRoute}
        screenOptions={{
          headerShown: false,
          animationEnabled: false, // アニメーション無効化（高速遷移）
        }}
      >
        {/* スタートアップ / 認証方式選択 */}
        <Stack.Screen name="Startup" component={StartupScreen} />
        
        {/* Web API 方式（非公式・メイン） */}
        <Stack.Screen name="WebAuth" component={WebAuthScreen} />
        <Stack.Screen name="AlbumSelectWeb" component={AlbumSelectWebScreen} />
        <Stack.Screen 
          name="HomeWeb" 
          component={HomeWebScreen}
          options={{
            animationEnabled: true,
            animation: 'slide_from_right',
          }}
        />
        <Stack.Screen 
          name="PhotoDetailWeb" 
          component={PhotoDetailWebScreen}
          options={{ presentation: 'modal' }}
        />
        <Stack.Screen 
          name="WebManage" 
          component={WebManageScreen}
          options={{ presentation: 'modal' }}
        />
        <Stack.Screen name="TrashWeb" component={TrashWebScreen} />
        <Stack.Screen name="FavoritesWeb" component={FavoritesWebScreen} />
        <Stack.Screen name="AlbumSearch" component={AlbumSearchScreen} />
        
        {/* OAuth 方式（公式・旧方式） */}
        <Stack.Screen name="Login" component={LoginScreen} />
        <Stack.Screen name="AlbumSelect" component={AlbumSelectScreen} />
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen
          name="PhotoDetail"
          component={PhotoDetailScreen}
          options={{ presentation: 'modal' }}
        />
      </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

/**
 * バックグラウンドでセッションを無音更新する非表示WebView
 */
function BackgroundSessionRefresh({ webViewRef, onMessage }) {
  const extractionScript = `
    (function() {
      try {
        if (typeof WIZ_global_data !== 'undefined' && WIZ_global_data.SNlM0e && WIZ_global_data.FdrFJe && WIZ_global_data.cfb2h) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'SESSION_DATA',
            data: {
              SNlM0e: WIZ_global_data.SNlM0e,
              FdrFJe: WIZ_global_data.FdrFJe,
              cfb2h: WIZ_global_data.cfb2h,
              qwAQke: WIZ_global_data.qwAQke,
            },
          }));
        } else {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACTION_FAILED' }));
        }
      } catch(e) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'EXTRACTION_FAILED' }));
      }
    })();
    true;
  `;

  return (
    <WebView
      ref={webViewRef}
      source={{ uri: 'https://photos.google.com/' }}
      style={{ width: 0, height: 0, position: 'absolute' }}
      onLoadEnd={(e) => {
        const url = e?.nativeEvent?.url || '';
        if (url.includes('photos.google.com') && !url.includes('accounts.google.com')) {
          webViewRef.current?.injectJavaScript(extractionScript);
        } else {
          // Cookieが切れてログインページにリダイレクトされた場合は何もしない
          onMessage({ nativeEvent: { data: JSON.stringify({ type: 'EXTRACTION_FAILED' }) } });
        }
      }}
      onMessage={onMessage}
      onError={() => onMessage({ nativeEvent: { data: JSON.stringify({ type: 'EXTRACTION_FAILED' }) } })}
      renderError={() => null}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      sharedCookiesEnabled={true}
      incognito={false}
      cacheEnabled={true}
      userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    />
  );
}

/**
 * スタートアップ画面 - 認証方式を選択
 */
function StartupScreen({ navigation }) {
  const handleWebAuth = async () => {
    await AsyncStorage.setItem(STORAGE_KEYS.AUTH_MODE, 'web');
    navigation.replace('WebAuth');
  };

  const handleOAuth = async () => {
    await AsyncStorage.setItem(STORAGE_KEYS.AUTH_MODE, 'oauth');
    navigation.replace('Login');
  };

  return (
    <React.Fragment>
      <StatusBar style="dark" />
      <StartupScreenUI onWebAuth={handleWebAuth} onOAuth={handleOAuth} />
    </React.Fragment>
  );
}

// スタートアップ画面のUI（Viewインポートを使わないよう別関数に分離）
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView } from 'react-native';

function StartupScreenUI({ onWebAuth, onOAuth }) {
  return (
    <SafeAreaView style={startupStyles.container}>
      <View style={startupStyles.content}>
        <Text style={startupStyles.title}>PhotoDate G</Text>
        <Text style={startupStyles.subtitle}>
          Googleフォトを{'\n'}もっと見やすく
        </Text>

        <View style={startupStyles.buttonContainer}>
          <TouchableOpacity
            style={startupStyles.primaryButton}
            onPress={onWebAuth}
          >
            <Text style={startupStyles.primaryButtonText}>
              🚀 はじめる
            </Text>
          </TouchableOpacity>
          
          <Text style={startupStyles.buttonDescription}>
            Googleアカウントでログインして{'\n'}
            共有アルバムをすぐに閲覧
          </Text>
        </View>

        <View style={startupStyles.features}>
          <Text style={startupStyles.featureTitle}>✨ 機能</Text>
          <Text style={startupStyles.featureItem}>• 共有アルバムの写真を即座に表示</Text>
          <Text style={startupStyles.featureItem}>• 日付別グループで見やすく整理</Text>
          <Text style={startupStyles.featureItem}>• 高画質サムネイル</Text>
          <Text style={startupStyles.featureItem}>• アップロード・管理はWebViewで</Text>
        </View>

        <TouchableOpacity
          style={startupStyles.secondaryButton}
          onPress={onOAuth}
        >
          <Text style={startupStyles.secondaryButtonText}>
            Picker API方式（旧）を使用
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const startupStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
  },
  title: {
    fontSize: 48,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 20,
    color: '#666',
    textAlign: 'center',
    marginBottom: 50,
    lineHeight: 28,
  },
  buttonContainer: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 40,
  },
  primaryButton: {
    backgroundColor: '#4285F4',
    paddingVertical: 16,
    paddingHorizontal: 50,
    borderRadius: 12,
    marginBottom: 12,
    shadowColor: '#4285F4',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  buttonDescription: {
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
    lineHeight: 18,
  },
  features: {
    width: '100%',
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 20,
    marginBottom: 30,
  },
  featureTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  featureItem: {
    fontSize: 14,
    color: '#555',
    marginBottom: 6,
    lineHeight: 20,
  },
  secondaryButton: {
    padding: 12,
  },
  secondaryButtonText: {
    fontSize: 14,
    color: '#999',
    textDecorationLine: 'underline',
  },
});
