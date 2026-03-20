import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { SafeAreaProvider } from 'react-native-safe-area-context';

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

const Stack = createStackNavigator();

const STORAGE_KEYS = {
  SESSION_DATA: '@photov_session_data',
  SELECTED_ALBUM: '@photov_selected_album',
  AUTH_MODE: '@photov_auth_mode', // 'web' または 'oauth'
};

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

  useEffect(() => {
    checkSavedSession();
  }, []);

  const checkSavedSession = async () => {
    try {
      // 保存済みセッションを確認
      const savedSession = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_DATA);
      
      if (savedSession) {
        const sessionData = JSON.parse(savedSession);
        
        // セッションが24時間以内なら再利用
        if (sessionData.savedAt && Date.now() - sessionData.savedAt < 24 * 60 * 60 * 1000) {
          if (sessionManager.setFromWizData(sessionData.wizData)) {
            // セッション有効
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

  if (!isReady) {
    return null; // スプラッシュ表示中
  }

  return (
    <SafeAreaProvider>
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
        <Stack.Screen name="HomeWeb" component={HomeWebScreen} />
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
