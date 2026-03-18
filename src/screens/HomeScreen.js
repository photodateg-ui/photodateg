import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  Image,
  Dimensions,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  Platform
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { 
  getThumbnailUrl, 
  isVideo,
  deletePickerSession 
} from '../services/googlePhotosAuth';

const { width } = Dimensions.get('window');
const numColumns = 3;
const imageSize = width / numColumns;

// 日付を日本語フォーマットに変換
const formatDateJapanese = (dateString) => {
  if (!dateString || dateString === 'Unknown') {
    return '日付不明';
  }
  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    return '日付不明';
  }
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const weekday = weekdays[date.getDay()];
  return `${month}月${day}日(${weekday})`;
};

// 写真の作成日時を取得（複数フォーマット対応）
const getPhotoDate = (photo) => {
  // Picker API形式: createTime
  if (photo.createTime) {
    return new Date(photo.createTime);
  }
  // mediaFile内のcreateTime
  if (photo.mediaFile?.createTime) {
    return new Date(photo.mediaFile.createTime);
  }
  // Library API形式: mediaMetadata.creationTime
  if (photo.mediaMetadata?.creationTime) {
    return new Date(photo.mediaMetadata.creationTime);
  }
  // その他のフォールバック
  if (photo.creationTime) {
    return new Date(photo.creationTime);
  }
  return null;
};

// 写真を日付でグループ化
const groupPhotosByDate = (photos) => {
  const groups = {};

  photos.forEach(photo => {
    const date = getPhotoDate(photo);
    const dateKey = date ? date.toDateString() : 'Unknown';

    if (!groups[dateKey]) {
      groups[dateKey] = [];
    }
    groups[dateKey].push(photo);
  });

  return Object.keys(groups)
    .sort((a, b) => {
      if (a === 'Unknown') return 1;
      if (b === 'Unknown') return -1;
      return new Date(b) - new Date(a);
    })
    .map(dateKey => ({
      title: formatDateJapanese(dateKey),
      data: groups[dateKey],
      dateKey
    }));
};

// 個別の写真アイテムコンポーネント
const PhotoItem = React.memo(({ photo, onPress }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  
  // getThumbnailUrlユーティリティを使用
  const photoUrl = getThumbnailUrl(photo, 400, 400, true) || photo.uri;
  const isVideoItem = isVideo(photo);

  return (
    <TouchableOpacity
      style={styles.photoContainer}
      onPress={onPress}
      activeOpacity={0.8}
    >
      {photoUrl && !hasError ? (
        <View style={styles.photoInner}>
          {!isLoaded && (
            <View style={[StyleSheet.absoluteFill, styles.loadingOverlay]}>
              <ActivityIndicator size="small" color="#4285F4" />
            </View>
          )}
          <Image
            source={{ uri: photoUrl }}
            style={styles.photo}
            resizeMode="cover"
            onLoad={() => setIsLoaded(true)}
            onError={() => setHasError(true)}
          />
          {isVideoItem && (
            <View style={styles.videoIndicator}>
              <Text style={styles.videoIndicatorText}>▶</Text>
            </View>
          )}
        </View>
      ) : (
        <View style={[styles.photoInner, styles.placeholderPhoto]}>
          <Text style={styles.placeholderText}>{hasError ? '⚠️' : '📷'}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
});

export default function HomeScreen({ route, navigation }) {
  const [photos, setPhotos] = useState([]);
  const [photoSections, setPhotoSections] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const accessToken = route.params?.accessToken;
  const mediaItems = route.params?.mediaItems;
  const albumTitle = route.params?.albumTitle || 'ファミリーボルト';
  const sessionId = route.params?.sessionId;

  useEffect(() => {
    requestPermissions();
    loadPhotos();
    
    // クリーンアップ: 画面を離れる際にセッションを削除
    return () => {
      if (sessionId && accessToken) {
        // 非同期でセッション削除（待たない）
        deletePickerSession(accessToken, sessionId).catch(console.warn);
      }
    };
  }, []);

  const requestPermissions = async () => {
    if (Platform.OS !== 'web') {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('権限が必要です', 'カメラロールへのアクセス権限が必要です');
      }
    }
  };

  const loadPhotos = useCallback(async () => {
    try {
      if (mediaItems && mediaItems.length > 0) {
        console.log('Using media items from Picker API:', mediaItems.length);
        setPhotos(mediaItems);
        const sections = groupPhotosByDate(mediaItems);
        setPhotoSections(sections);
        setIsLoading(false);
        return;
      }

      // デモモード: モックデータを使用
      const mockPhotos = Array.from({ length: 50 }, (_, i) => ({
        id: `photo-${i}`,
        baseUrl: `https://picsum.photos/400/400?random=${i}`,
        createTime: new Date(2024, 0, Math.floor(i / 5) + 1).toISOString(),
      }));
      setPhotos(mockPhotos);
      const sections = groupPhotosByDate(mockPhotos);
      setPhotoSections(sections);
    } catch (error) {
      console.error('写真の読み込みエラー:', error);
      Alert.alert('エラー', '写真の読み込みに失敗しました');
    } finally {
      setIsLoading(false);
    }
  }, [mediaItems]);

  const pickImages = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        quality: 1,
      });

      if (!result.canceled) {
        const newPhotos = result.assets.map((asset, index) => ({
          id: `local-${Date.now()}-${index}`,
          uri: asset.uri,
          baseUrl: asset.uri,
          createTime: new Date().toISOString(),
        }));

        const updatedPhotos = [...newPhotos, ...photos];
        setPhotos(updatedPhotos);
        const sections = groupPhotosByDate(updatedPhotos);
        setPhotoSections(sections);
      }
    } catch (error) {
      console.error('写真の選択エラー:', error);
      Alert.alert('エラー', '写真の選択に失敗しました');
    }
  };

  const openPhotoDetail = useCallback((photo) => {
    navigation.navigate('PhotoDetail', {
      photo,
      accessToken,
    });
  }, [navigation, accessToken]);

  const renderSectionHeader = useCallback(({ section }) => (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{section.title}</Text>
    </View>
  ), []);

  const renderRow = useCallback(({ item: rowPhotos }) => (
    <View style={styles.row}>
      {rowPhotos.map((photo, index) => (
        <View key={photo.id || `photo-${index}`} style={styles.photoWrapper}>
          <PhotoItem 
            photo={photo} 
            onPress={() => openPhotoDetail(photo)} 
          />
        </View>
      ))}
      {Array.from({ length: numColumns - rowPhotos.length }).map((_, index) => (
        <View key={`empty-${index}`} style={styles.photoWrapper} />
      ))}
    </View>
  ), [openPhotoDetail]);

  const getSectionsWithRows = useCallback(() => {
    return photoSections.map(section => ({
      ...section,
      data: chunkArray(section.data, numColumns),
    }));
  }, [photoSections]);

  const chunkArray = (array, size) => {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#4285F4" />
          <Text style={styles.loadingText}>写真を読み込んでいます...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backButtonText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{albumTitle}</Text>
        <TouchableOpacity style={styles.addButton} onPress={pickImages}>
          <Text style={styles.addButtonText}>+</Text>
        </TouchableOpacity>
      </View>

      {photos.length > 0 ? (
        <SectionList
          sections={getSectionsWithRows()}
          renderItem={renderRow}
          renderSectionHeader={renderSectionHeader}
          keyExtractor={(item, index) => `row-${index}`}
          stickySectionHeadersEnabled={true}
          showsVerticalScrollIndicator={false}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={5}
        />
      ) : (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>📷</Text>
          <Text style={styles.emptyText}>写真がありません</Text>
          <TouchableOpacity style={styles.addPhotosButton} onPress={pickImages}>
            <Text style={styles.addPhotosButtonText}>写真を追加</Text>
          </TouchableOpacity>
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
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 10,
    color: '#666',
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
  addButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addButtonText: {
    fontSize: 28,
    color: '#4285F4',
  },
  sectionHeader: {
    backgroundColor: '#f8f8f8',
    paddingVertical: 8,
    paddingHorizontal: 15,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  row: {
    flexDirection: 'row',
  },
  photoWrapper: {
    width: imageSize,
    height: imageSize,
  },
  photoContainer: {
    flex: 1,
    margin: 1,
  },
  photoInner: {
    width: '100%',
    height: '100%',
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  loadingOverlay: {
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderPhoto: {
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    fontSize: 24,
  },
  videoIndicator: {
    position: 'absolute',
    bottom: 5,
    right: 5,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 12,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoIndicatorText: {
    color: '#fff',
    fontSize: 10,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 10,
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 20,
  },
  addPhotosButton: {
    backgroundColor: '#4285F4',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  addPhotosButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
