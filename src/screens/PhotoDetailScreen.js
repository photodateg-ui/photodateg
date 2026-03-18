import React, { useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  Dimensions,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  PanResponder,
} from 'react-native';
import { getFullSizeUrl, getVideoUrl, isVideo } from '../services/googlePhotosAuth';

const { width, height } = Dimensions.get('window');

// 日付を取得（複数のフォーマットに対応）
const getPhotoDate = (photo) => {
  // Picker API: createTime
  if (photo.createTime) {
    return new Date(photo.createTime);
  }
  // mediaFile内のcreateTime
  if (photo.mediaFile?.createTime) {
    return new Date(photo.mediaFile.createTime);
  }
  // Library API: mediaMetadata.creationTime
  if (photo.mediaMetadata?.creationTime) {
    return new Date(photo.mediaMetadata.creationTime);
  }
  // その他
  if (photo.creationTime) {
    return new Date(photo.creationTime);
  }
  if (photo.date) {
    return new Date(photo.date);
  }
  return null;
};

// 日付フォーマット
const formatDate = (date) => {
  if (!date || isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
};

export default function PhotoDetailScreen({ route, navigation }) {
  const { photo, accessToken } = route.params;
  const [isLoading, setIsLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  
  // ズーム用のアニメーション値
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  
  // ダブルタップ検出用
  const lastTap = useRef(0);
  const isZoomed = useRef(false);

  // メモ化した値
  const isVideoItem = useMemo(() => isVideo(photo), [photo]);
  const photoDate = useMemo(() => getPhotoDate(photo), [photo]);
  
  // 高画質画像URL（デバイスのピクセル密度を考慮）
  const imageUrl = useMemo(() => {
    if (photo.uri) {
      return photo.uri; // ローカルファイル
    }
    
    if (isVideoItem) {
      // 動画の場合はサムネイルを表示
      return getFullSizeUrl(photo, Math.round(width * 2), Math.round(height * 2));
    }
    
    return getFullSizeUrl(photo, Math.round(width * 2), Math.round(height * 2));
  }, [photo, isVideoItem]);

  // ダブルタップでズームイン/アウト
  const handleDoubleTap = () => {
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 300;
    
    if (now - lastTap.current < DOUBLE_TAP_DELAY) {
      // ダブルタップ
      if (isZoomed.current) {
        // ズームアウト
        Animated.parallel([
          Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
        ]).start();
        isZoomed.current = false;
      } else {
        // ズームイン
        Animated.spring(scale, { toValue: 2, useNativeDriver: true }).start();
        isZoomed.current = true;
      }
    }
    lastTap.current = now;
  };

  // パンジェスチャー（ズーム時のドラッグ）
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: () => isZoomed.current,
      onPanResponderMove: (_, gestureState) => {
        translateX.setValue(gestureState.dx);
        translateY.setValue(gestureState.dy);
      },
      onPanResponderRelease: () => {
        // 位置をリセット（バウンス）
        Animated.parallel([
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
        ]).start();
      },
    })
  ).current;

  return (
    <View style={styles.container}>
      {/* 閉じるボタン */}
      <TouchableOpacity
        style={styles.closeButton}
        onPress={() => navigation.goBack()}
      >
        <Text style={styles.closeButtonText}>✕</Text>
      </TouchableOpacity>

      {/* 画像表示エリア */}
      <View style={styles.imageContainer}>
        {isLoading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.loadingText}>読み込み中...</Text>
          </View>
        )}
        
        {imageError ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorText}>画像を読み込めませんでした</Text>
          </View>
        ) : imageUrl ? (
          <TouchableOpacity
            activeOpacity={1}
            onPress={handleDoubleTap}
            style={styles.imageTouchable}
            {...panResponder.panHandlers}
          >
            <Animated.Image
              source={{ uri: imageUrl }}
              style={[
                styles.photo,
                {
                  transform: [
                    { scale },
                    { translateX },
                    { translateY },
                  ],
                },
              ]}
              resizeMode="contain"
              onLoad={() => setIsLoading(false)}
              onError={() => {
                setIsLoading(false);
                setImageError(true);
              }}
            />
            {isVideoItem && (
              <View style={styles.videoOverlay}>
                <Text style={styles.videoPlayIcon}>▶</Text>
                <Text style={styles.videoText}>動画はダウンロードが必要です</Text>
              </View>
            )}
          </TouchableOpacity>
        ) : (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>📷</Text>
            <Text style={styles.errorText}>画像URLが見つかりません</Text>
          </View>
        )}
      </View>

      {/* 日付情報 */}
      {photoDate && (
        <View style={styles.infoContainer}>
          <Text style={styles.dateText}>{formatDate(photoDate)}</Text>
        </View>
      )}

      {/* ヒント */}
      <View style={styles.hintContainer}>
        <Text style={styles.hintText}>ダブルタップでズーム</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  closeButton: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '300',
  },
  imageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageTouchable: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  photo: {
    width: width,
    height: height * 0.75,
  },
  loadingContainer: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 5,
  },
  loadingText: {
    color: '#fff',
    marginTop: 10,
    fontSize: 14,
  },
  errorContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 10,
  },
  errorText: {
    color: '#999',
    fontSize: 16,
  },
  videoOverlay: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoPlayIcon: {
    fontSize: 64,
    color: '#fff',
    opacity: 0.8,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  videoText: {
    color: '#fff',
    fontSize: 14,
    marginTop: 10,
    opacity: 0.8,
  },
  infoContainer: {
    position: 'absolute',
    bottom: 100,
    left: 0,
    right: 0,
    paddingVertical: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  dateText: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
  },
  hintContainer: {
    position: 'absolute',
    bottom: 50,
    left: 0,
    right: 0,
  },
  hintText: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
  },
});
