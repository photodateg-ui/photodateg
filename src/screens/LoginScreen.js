import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useGooglePhotosAuth } from '../services/googlePhotosAuth';
import { GOOGLE_AUTH_CONFIG } from '../config/googleAuth';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen({ navigation }) {
  const { request, response, promptAsync, redirectUri, isExpoGo, clientId } = useGooglePhotosAuth();
  const [isLoading, setIsLoading] = useState(false);

  // デバッグ情報
  useEffect(() => {
    console.log('=== Auth Config ===');
    console.log('isExpoGo:', isExpoGo);
    console.log('clientId:', clientId);
    console.log('redirectUri:', redirectUri);
  }, [isExpoGo, clientId, redirectUri]);

  // 認証レスポンスの処理
  const handleAuthResponse = useCallback(async () => {
    if (!response) return;
    
    console.log('Auth response type:', response.type);
    
    if (response.type === 'success') {
      console.log('Auth success:', JSON.stringify(response, null, 2));
      
      // Implicit flow: authentication.accessToken が直接含まれる
      if (response.authentication?.accessToken) {
        console.log('Using implicit flow token');
        navigation.navigate('AlbumSelect', {
          accessToken: response.authentication.accessToken,
        });
        return;
      }
      
      // Authorization Code flow: params.code をトークンに交換
      if (response.params?.code) {
        console.log('Exchanging authorization code for token...');
        try {
          const tokenResponse = await fetch(GOOGLE_AUTH_CONFIG.discovery.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              code: response.params.code,
              code_verifier: request?.codeVerifier || '',
              grant_type: 'authorization_code',
              redirect_uri: redirectUri,
            }).toString(),
          });
          
          const tokenData = await tokenResponse.json();
          console.log('Token response:', JSON.stringify(tokenData, null, 2));
          
          if (tokenData.access_token) {
            navigation.navigate('AlbumSelect', {
              accessToken: tokenData.access_token,
            });
          } else {
            console.error('Token error:', tokenData);
            const errorMessage = tokenData.error_description || tokenData.error || '不明なエラー';
            Alert.alert('認証エラー', `アクセストークンの取得に失敗しました。\n\n${errorMessage}`);
          }
        } catch (error) {
          console.error('Token exchange error:', error);
          Alert.alert('認証エラー', `トークン交換に失敗しました。\n\n${error.message}`);
        }
      }
    } else if (response.type === 'error') {
      console.log('Auth error:', JSON.stringify(response, null, 2));
      const errorMessage = response.error?.message || response.params?.error_description || '認証に失敗しました';
      Alert.alert('認証エラー', errorMessage);
    } else if (response.type === 'cancel' || response.type === 'dismiss') {
      console.log('Auth cancelled');
      // キャンセルは何もしない
    }
    
    setIsLoading(false);
  }, [response, request, clientId, redirectUri, navigation]);

  useEffect(() => {
    handleAuthResponse();
  }, [handleAuthResponse]);

  const handleLogin = async () => {
    if (!request) {
      Alert.alert('エラー', '認証の準備ができていません。しばらく待ってから再度お試しください。');
      return;
    }
    
    setIsLoading(true);
    try {
      // 認証フローを開始
      // Expo Goの場合はExpoのプロキシを使用しない（expo-auth-sessionの最新推奨）
      const result = await promptAsync();
      console.log('promptAsync result:', result?.type);
    } catch (error) {
      console.error('認証エラー:', error);
      Alert.alert('エラー', `認証処理中にエラーが発生しました\n\n${error.message}`);
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>PhotoV</Text>
      <Text style={styles.subtitle}>
        Googleフォトを{'\n'}
        もっと見やすく
      </Text>

      <TouchableOpacity
        style={[styles.loginButton, (!request || isLoading) && styles.loginButtonDisabled]}
        onPress={handleLogin}
        disabled={!request || isLoading}
      >
        <Text style={styles.loginButtonText}>
          {isLoading ? '認証中...' : 'Googleでログイン'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.skipButton}
        onPress={() => navigation.navigate('AlbumSelect')}
      >
        <Text style={styles.skipButtonText}>
          スキップ（デモモードで確認）
        </Text>
      </TouchableOpacity>

      <Text style={styles.description}>
        GoogleフォトのコンテンツをAmazon Photosのような{'\n'}
        高品質なビューで閲覧できます
      </Text>
      
      {/* デバッグ情報（開発中のみ表示） */}
      {__DEV__ && (
        <View style={styles.debugContainer}>
          <Text style={styles.debugText}>
            Mode: {isExpoGo ? 'Expo Go' : 'Standalone'}
          </Text>
          <Text style={styles.debugText} numberOfLines={1}>
            Redirect: {redirectUri}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
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
  },
  loginButton: {
    backgroundColor: '#4285F4',
    paddingHorizontal: 40,
    paddingVertical: 15,
    borderRadius: 8,
    marginBottom: 15,
  },
  loginButtonDisabled: {
    backgroundColor: '#a0c4f4',
  },
  loginButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  skipButton: {
    paddingHorizontal: 40,
    paddingVertical: 15,
    marginBottom: 30,
  },
  skipButtonText: {
    color: '#4285F4',
    fontSize: 16,
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
  description: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
    lineHeight: 20,
  },
  debugContainer: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    padding: 10,
    backgroundColor: '#f0f0f0',
    borderRadius: 5,
  },
  debugText: {
    fontSize: 10,
    color: '#666',
    fontFamily: 'monospace',
  },
});
