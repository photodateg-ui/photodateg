import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Keyboard,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

const SCREEN_HEIGHT = Dimensions.get('window').height;

/**
 * アルバム内検索画面
 *
 * Google フォトの検索ページをWebViewで直接表示
 */
export default function AlbumSearchScreen({ navigation }) {
  const [query, setQuery] = useState('');
  const [searchUrl, setSearchUrl] = useState('https://photos.google.com/search');
  const [webViewKey, setWebViewKey] = useState(0);

  const webViewRef = useRef(null);

  const submitSearch = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;

    Keyboard.dismiss();
    const url = `https://photos.google.com/search/${encodeURIComponent(trimmed)}`;
    setSearchUrl(url);
    setWebViewKey(prev => prev + 1);
  }, [query]);

  return (
    <SafeAreaView style={styles.container}>
      {/* ヘッダー */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Text style={styles.backButtonText}>← 戻る</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>🔍 検索</Text>
        <View style={styles.headerRight} />
      </View>

      {/* 検索入力 */}
      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="キーワードを入力..."
          placeholderTextColor="#aaa"
          returnKeyType="search"
          onSubmitEditing={submitSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.searchButton} onPress={submitSearch}>
          <Text style={styles.searchButtonText}>検索</Text>
        </TouchableOpacity>
      </View>

      {/* Google フォト検索WebView */}
      <WebView
        key={webViewKey}
        ref={webViewRef}
        source={{ uri: searchUrl }}
        style={styles.webView}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        cacheEnabled={false}
      />
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
  searchBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  searchInput: {
    flex: 1,
    height: 44,
    backgroundColor: '#f0f0f0',
    borderRadius: 22,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#333',
  },
  searchButton: {
    backgroundColor: '#4285F4',
    borderRadius: 22,
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  searchButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 15,
  },
  webView: {
    flex: 1,
  },
});
