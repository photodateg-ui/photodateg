import React, { useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { WebView } from 'react-native-webview';

/**
 * WebViewでGoogleフォトを開いて管理するスクリーン
 * アップロード・編集・削除などの操作を行う
 */
export default function WebManageScreen({ route, navigation }) {
  const webViewRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [currentUrl, setCurrentUrl] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);

  const initialUrl = route?.params?.initialUrl || 'https://photos.google.com';

  const handleNavigationStateChange = useCallback((navState) => {
    setCurrentUrl(navState.url);
    setCanGoBack(navState.canGoBack);
  }, []);

  const handleGoBack = useCallback(() => {
    if (canGoBack) {
      webViewRef.current?.goBack();
    } else {
      navigation.goBack();
    }
  }, [canGoBack, navigation]);

  const handleRefresh = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  const handleClose = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerButton} onPress={handleGoBack}>
          <Text style={styles.headerButtonText}>
            {canGoBack ? '←' : '閉じる'}
          </Text>
        </TouchableOpacity>
        
        <Text style={styles.headerTitle} numberOfLines={1}>
          Googleフォト
        </Text>
        
        <TouchableOpacity style={styles.headerButton} onPress={handleRefresh}>
          <Text style={styles.headerButtonText}>↻</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.infoBar}>
        <Text style={styles.infoText}>
          📤 アップロードや編集はこちらで行えます
        </Text>
      </View>

      <WebView
        ref={webViewRef}
        source={{ uri: initialUrl }}
        style={styles.webview}
        onLoadStart={() => setIsLoading(true)}
        onLoadEnd={() => setIsLoading(false)}
        onNavigationStateChange={handleNavigationStateChange}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo={true}
        cacheEnabled={true}
        userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
      />

      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#4285F4" />
        </View>
      )}

      <View style={styles.footer}>
        <TouchableOpacity style={styles.footerButton} onPress={handleClose}>
          <Text style={styles.footerButtonText}>完了</Text>
        </TouchableOpacity>
      </View>
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
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerButton: {
    padding: 10,
    minWidth: 60,
  },
  headerButtonText: {
    color: '#4285F4',
    fontSize: 16,
    fontWeight: '500',
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
  },
  infoBar: {
    backgroundColor: '#E8F0FE',
    paddingVertical: 8,
    paddingHorizontal: 15,
  },
  infoText: {
    fontSize: 13,
    color: '#1A73E8',
    textAlign: 'center',
  },
  webview: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  footer: {
    padding: 15,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    alignItems: 'center',
  },
  footerButton: {
    backgroundColor: '#4285F4',
    paddingVertical: 12,
    paddingHorizontal: 50,
    borderRadius: 8,
  },
  footerButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
