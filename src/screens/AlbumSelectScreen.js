import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  Alert,
} from 'react-native';
import {
  createPickerSession,
  openPhotoPicker,
  waitForMediaSelection,
  listAllPickedMediaItems,
  deletePickerSession,
} from '../services/googlePhotosAuth';

export default function AlbumSelectScreen({ route, navigation }) {
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('');
  const accessToken = route.params?.accessToken;
  
  // セッションIDを保持（クリーンアップ用）
  const sessionIdRef = useRef(null);

  // Picker APIで写真を選択
  const startPhotoPicker = async () => {
    if (!accessToken) {
      Alert.alert('エラー', 'ログインが必要です');
      return;
    }

    setIsLoading(true);
    setStatus('セッションを作成中...');

    try {
      // 1. セッションを作成
      const session = await createPickerSession(accessToken);
      sessionIdRef.current = session.id;
      console.log('Session created:', JSON.stringify(session, null, 2));
      
      // 2. Picker UIを開く
      setStatus('Google Photosを開いています...');
      await openPhotoPicker(session.pickerUri);
      
      // 3. 選択完了を待つ（pollingConfigに従う）
      setStatus('写真を選択してください...');
      const result = await waitForMediaSelection(
        accessToken, 
        session.id, 
        session.pollingConfig
      );
      
      if (result.timedOut) {
        Alert.alert(
          'タイムアウト', 
          '写真の選択がタイムアウトしました。\nもう一度お試しください。',
          [{ text: 'OK' }]
        );
        setIsLoading(false);
        setStatus('');
        return;
      }
      
      if (!result.completed) {
        Alert.alert('情報', '写真の選択がキャンセルされました');
        setIsLoading(false);
        setStatus('');
        return;
      }
      
      // 4. 選択されたメディアを取得（全ページ）
      setStatus('選択された写真を読み込んでいます...');
      const mediaItems = await listAllPickedMediaItems(accessToken, session.id);
      console.log('Picked media items:', mediaItems.length);
      
      if (mediaItems.length === 0) {
        Alert.alert('情報', '写真が選択されませんでした');
        setIsLoading(false);
        setStatus('');
        return;
      }
      
      // 5. Home画面に遷移
      // 注意: セッションはここでは削除しない
      // baseURLの有効期限（60分）内にコンテンツを取得するため
      // Home画面から戻ってきたときにクリーンアップする
      navigation.navigate('Home', {
        accessToken,
        mediaItems,
        albumTitle: `選択した写真 (${mediaItems.length}枚)`,
        sessionId: session.id, // セッションIDを渡す
      });
      
    } catch (error) {
      console.error('Photo picker error:', error);
      Alert.alert('エラー', `写真の選択に失敗しました\n\n${error.message}`);
    } finally {
      setIsLoading(false);
      setStatus('');
    }
  };

  // 画面を離れる際のクリーンアップ
  React.useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', async () => {
      // セッションが残っていれば削除
      if (sessionIdRef.current && accessToken) {
        await deletePickerSession(accessToken, sessionIdRef.current);
        sessionIdRef.current = null;
      }
    });

    return unsubscribe;
  }, [navigation, accessToken]);

  // デモモードの場合
  const startDemoMode = () => {
    navigation.navigate('Home', {
      accessToken: null,
      mediaItems: [],
      albumTitle: 'デモモード',
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backButtonText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>写真を選択</Text>
        <View style={styles.placeholder} />
      </View>

      <View style={styles.content}>
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#4285F4" />
            <Text style={styles.statusText}>{status}</Text>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => {
                // ポーリングをキャンセルする場合の処理
                // 実際にはwaitForMediaSelectionをAbortControllerで制御する必要がある
                setIsLoading(false);
                setStatus('');
              }}
            >
              <Text style={styles.cancelButtonText}>キャンセル</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.buttonContainer}>
            <Text style={styles.description}>
              Google Photosから写真を選択して{'\n'}
              PhotoVで閲覧できます
            </Text>
            
            <TouchableOpacity
              style={[styles.pickerButton, !accessToken && styles.pickerButtonDisabled]}
              onPress={startPhotoPicker}
              disabled={!accessToken}
            >
              <Text style={styles.pickerButtonIcon}>📷</Text>
              <Text style={styles.pickerButtonText}>
                {accessToken ? 'Google Photosから選択' : 'ログインが必要です'}
              </Text>
            </TouchableOpacity>
            
            {!accessToken && (
              <>
                <Text style={styles.loginHint}>
                  ログイン画面からGoogleアカウントで{'\n'}
                  認証してください
                </Text>
                <TouchableOpacity
                  style={styles.demoButton}
                  onPress={startDemoMode}
                >
                  <Text style={styles.demoButtonText}>デモモードで試す</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
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
    paddingTop: 10,
    paddingBottom: 10,
    paddingHorizontal: 15,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButtonText: {
    fontSize: 28,
    color: '#333',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#333',
  },
  placeholder: {
    width: 40,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loadingContainer: {
    alignItems: 'center',
  },
  statusText: {
    marginTop: 20,
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  },
  cancelButton: {
    marginTop: 30,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  cancelButtonText: {
    color: '#999',
    fontSize: 14,
  },
  buttonContainer: {
    alignItems: 'center',
  },
  description: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 30,
    lineHeight: 24,
  },
  pickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#4285F4',
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 10,
    marginBottom: 15,
  },
  pickerButtonDisabled: {
    backgroundColor: '#ccc',
  },
  pickerButtonIcon: {
    fontSize: 24,
    marginRight: 10,
  },
  pickerButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  loginHint: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  demoButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  demoButtonText: {
    color: '#4285F4',
    fontSize: 16,
  },
});
