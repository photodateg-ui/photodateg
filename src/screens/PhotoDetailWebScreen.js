import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  Dimensions,
  StatusBar,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Image } from 'expo-image';
import ImageViewer from 'react-native-image-zoom-viewer';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { getFullSizeUrl, isVideoItem } from '../services/googlePhotosWebApi';
// Exify: ネイティブモジュールのため動的require（Expo Goではスキップ）

const { width, height } = Dimensions.get('window');

export default function PhotoDetailWebScreen({ route, navigation }) {
  const { photos = [], initialIndex = 0 } = route.params;
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // 画像URLリストを作成（オリジナルサイズ、制限なし）
  const imageUrls = photos.map(photo => ({
    url: getFullSizeUrl(photo.thumb, 0, 0), // オリジナルサイズそのまま
  }));

  // 前後の画像をプリロード
  useEffect(() => {
    const indicesToPrefetch = [
      currentIndex - 2,
      currentIndex - 1,
      currentIndex + 1,
      currentIndex + 2,
    ].filter(i => i >= 0 && i < photos.length);
    
    for (const i of indicesToPrefetch) {
      const url = getFullSizeUrl(photos[i].thumb, 2048, 2048);
      Image.prefetch(url);
    }
  }, [currentIndex, photos]);

  const currentPhoto = photos[currentIndex];
  const isCurrentVideo = currentPhoto ? isVideoItem(currentPhoto) : false;
  
  // 動画URL
  const getVideoUrl = (photo) => {
    if (!photo || !photo.thumb) return null;
    const baseUrl = photo.thumb.split('=')[0];
    return `${baseUrl}=dv`;
  };

  const handleIndexChange = useCallback((index) => {
    setCurrentIndex(index);
    setIsVideoPlaying(false);
  }, []);

  const handlePlayVideo = useCallback(() => {
    setIsVideoPlaying(true);
  }, []);

  const handleSwipeDown = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // 動画モーダルを閉じてリストに戻る
  const closeVideoModal = useCallback(() => {
    setIsVideoPlaying(false);
    navigation.goBack();
  }, [navigation]);

  // 現在の写真/動画をダウンロード
  const downloadCurrentPhoto = useCallback(async () => {
    if (!currentPhoto) return;

    setIsDownloading(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('エラー', '写真へのアクセス許可が必要です');
        setIsDownloading(false);
        return;
      }

      // 動画か写真か判定
      const isVideo = isVideoItem(currentPhoto);

      // ダウンロードURLを取得
      let downloadUrl;
      let isLocalFile = false;
      
      if (isVideo) {
        // 動画：baseUrl + =dv パラメータ
        const baseUrl = currentPhoto.thumb.split('=')[0];
        downloadUrl = `${baseUrl}=dv`;
        // ローカルURI判定
        if (downloadUrl.startsWith('file://') || downloadUrl.startsWith('content://') || downloadUrl.startsWith('ph://')) {
          isLocalFile = true;
        }
      } else {
        // 写真：表示中の画像URL（オリジナルサイズ）
        downloadUrl = imageUrls[currentIndex]?.url;
        // ローカルURI判定
        if (downloadUrl && (downloadUrl.startsWith('file://') || downloadUrl.startsWith('content://') || downloadUrl.startsWith('ph://'))) {
          isLocalFile = true;
        }
      }
      
      // ローカルURIの場合（楽観的更新で追加された写真）
      if (isLocalFile) {
        // ローカルファイルが存在するか確認
        try {
          const fileInfo = await FileSystem.getInfoAsync(downloadUrl);
          if (fileInfo.exists) {
            // ファイルが存在する場合、直接カメラロールに保存
            await MediaLibrary.createAssetAsync(downloadUrl);
            Alert.alert('完了', '写真をカメラロールに保存しました');
            setIsDownloading(false);
            return;
          } else {
            // ファイルが存在しない場合
            Alert.alert('エラー', 'この写真はまだ同期中です。\nしばらくしてから再度お試しください。');
            setIsDownloading(false);
            return;
          }
        } catch (localError) {
          Alert.alert('エラー', 'この写真はまだ同期中です。\nしばらくしてから再度お試しください。');
          setIsDownloading(false);
          return;
        }
      }
      
      // URL未取得の場合
      if (!downloadUrl) {
        Alert.alert('エラー', 'ダウンロードURLを取得できませんでした');
        setIsDownloading(false);
        return;
      }

      // 撮影日時からファイル名を生成
      let filename;
      const ext = isVideo ? 'mp4' : 'jpg';
      if (currentPhoto.timestamp) {
        const date = new Date(currentPhoto.timestamp);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hour = String(date.getHours()).padStart(2, '0');
        const minute = String(date.getMinutes()).padStart(2, '0');
        const second = String(date.getSeconds()).padStart(2, '0');
        filename = `PhotoV_${year}-${month}-${day}_${hour}-${minute}-${second}.${ext}`;
      } else {
        filename = `PhotoV_${Date.now()}.${ext}`;
      }
      const fileUri = FileSystem.documentDirectory + filename;

      // ダウンロード
      const downloadResult = await FileSystem.downloadAsync(downloadUrl, fileUri);

      // EXIF情報を書き込み（写真のみ）
      if (!isVideo) {
        try {
          if (currentPhoto.timestamp) {
            const date = new Date(currentPhoto.timestamp);
            // EXIF仕様: "YYYY:MM:DD HH:MM:SS" (コロン区切り)
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hour = String(date.getHours()).padStart(2, '0');
            const minute = String(date.getMinutes()).padStart(2, '0');
            const second = String(date.getSeconds()).padStart(2, '0');
            const dateString = `${year}:${month}:${day} ${hour}:${minute}:${second}`;

            const { Exify } = require('@lodev09/react-native-exify');
            await Exify.write(downloadResult.uri, {
              DateTimeOriginal: dateString,
              DateTime: dateString,
              UserComment: `Downloaded from PhotoV - Original timestamp: ${currentPhoto.timestamp}`,
            });
          }
        } catch (exifError) {
          console.warn('EXIF write failed:', exifError);
          // EXIF書き込み失敗しても続行
        }
      }

      // カメラロールに保存
      await MediaLibrary.createAssetAsync(downloadResult.uri);

      // 一時ファイルを削除
      await FileSystem.deleteAsync(downloadResult.uri, { idempotent: true });

      const mediaType = isVideo ? '動画' : '写真';
      Alert.alert('完了', `${mediaType}をカメラロールに保存しました`);
    } catch (error) {
      console.error('Download error:', error);
      Alert.alert('エラー', `ダウンロードに失敗しました\n\n${error.message}`);
    } finally {
      setIsDownloading(false);
    }
  }, [currentPhoto, currentIndex, imageUrls]);

  // 次のファイルへ
  const goToNext = useCallback(() => {
    if (currentIndex < photos.length - 1) {
      setIsVideoPlaying(false);
      setCurrentIndex(currentIndex + 1);
    }
  }, [currentIndex, photos.length]);

  // 前のファイルへ
  const goToPrev = useCallback(() => {
    if (currentIndex > 0) {
      setIsVideoPlaying(false);
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  // 動画モーダル用のジェスチャー（左右スワイプのみ）
  const panGesture = Gesture.Pan()
    .onEnd((event) => {
      const { translationX, velocityX } = event;
      
      // 左スワイプで次へ
      if (translationX < -80 || velocityX < -400) {
        goToNext();
        return;
      }
      
      // 右スワイプで前へ
      if (translationX > 80 || velocityX > 400) {
        goToPrev();
        return;
      }
    });

  // 動画再生モーダル
  const renderVideoModal = () => {
    const videoUrl = getVideoUrl(currentPhoto);
    
    const videoHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { background: #000; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
          video { max-width: 100%; max-height: 100vh; }
        </style>
      </head>
      <body>
        <video id="video" src="${videoUrl}" controls playsinline webkit-playsinline style="width:100%;height:100%;">
          動画を再生できません
        </video>
        <script>
          document.addEventListener('DOMContentLoaded', function() {
            var video = document.getElementById('video');
            video.muted = true;
            video.play().then(function() {
              video.muted = false;
            }).catch(function(e) {
              console.log('Auto-play failed:', e);
            });
          });
        </script>
      </body>
      </html>
    `;
    
    return (
      <Modal
        visible={isVideoPlaying}
        animationType="fade"
        onRequestClose={closeVideoModal}
      >
        <GestureDetector gesture={panGesture}>
          <View style={styles.videoModal}>
            <SafeAreaView style={styles.videoHeader}>
              <TouchableOpacity
                style={styles.videoCloseButton}
                onPress={closeVideoModal}
              >
                <Text style={styles.closeButtonText}>✕ 閉じる</Text>
              </TouchableOpacity>
              <Text style={styles.videoCounter}>{currentIndex + 1} / {photos.length}</Text>
            </SafeAreaView>
            
            <View style={styles.videoContainer}>
              <WebView
                source={{ html: videoHtml }}
                style={styles.videoWebView}
                allowsInlineMediaPlayback
                mediaPlaybackRequiresUserAction={false}
                javaScriptEnabled
                domStorageEnabled
                sharedCookiesEnabled={true}
                thirdPartyCookiesEnabled={true}
              />
            </View>
            
            {/* 下部：閉じるボタンのみ */}
            <View style={styles.videoFooter}>
              <TouchableOpacity
                style={styles.closeFooterButton}
                onPress={closeVideoModal}
              >
                <Text style={styles.closeFooterText}>✕ 閉じる</Text>
              </TouchableOpacity>
            </View>
          </View>
        </GestureDetector>
      </Modal>
    );
  };

  // 動画オーバーレイ（再生ボタンのみタップ可能）
  const renderVideoOverlay = () => {
    if (!isCurrentVideo) return null;
    
    return (
      <View style={styles.videoOverlay} pointerEvents="box-none">
        <TouchableOpacity
          style={styles.videoPlayButton}
          activeOpacity={0.8}
          onPress={handlePlayVideo}
        >
          <Text style={styles.videoPlayIcon}>▶</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      
      <ImageViewer
        imageUrls={imageUrls}
        index={initialIndex}
        onChange={handleIndexChange}
        enableSwipeDown
        onSwipeDown={handleSwipeDown}
        swipeDownThreshold={80}
        saveToLocalByLongPress={false}
        renderIndicator={() => null}
        backgroundColor="#000"
        enablePreload
      />

      {renderVideoOverlay()}

      {/* ヘッダー */}
      <SafeAreaView style={styles.headerContainer} pointerEvents="box-none">
        <View style={styles.header} pointerEvents="box-none">
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.closeButtonText}>✕</Text>
          </TouchableOpacity>

          <Text style={styles.dateText}>
            {currentPhoto?.timestamp
              ? (() => {
                  const d = new Date(currentPhoto.timestamp);
                  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
                })()
              : ''}
          </Text>

          <TouchableOpacity
            style={styles.downloadButton}
            onPress={downloadCurrentPhoto}
            disabled={isDownloading}
          >
            {isDownloading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.downloadButtonText}>⬇</Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* フッター：ページ番号 */}
      <View style={styles.footerContainer} pointerEvents="none">
        <Text style={styles.counter}>
          {currentIndex + 1} / {photos.length}
        </Text>
      </View>

      {renderVideoModal()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  videoOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoPlayButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoPlayIcon: {
    color: '#fff',
    fontSize: 32,
    marginLeft: 5,
  },
  videoModal: {
    flex: 1,
    backgroundColor: '#000',
  },
  videoHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 10,
    backgroundColor: '#000',
  },
  videoContainer: {
    flex: 1,
  },
  videoWebView: {
    flex: 1,
    backgroundColor: '#000',
  },
  videoCloseButton: {
    paddingVertical: 8,
    paddingHorizontal: 15,
    backgroundColor: '#333',
    borderRadius: 20,
  },
  videoCounter: {
    color: '#fff',
    fontSize: 14,
  },
  videoFooter: {
    alignItems: 'center',
    paddingVertical: 15,
    backgroundColor: '#000',
  },
  closeFooterButton: {
    paddingVertical: 12,
    paddingHorizontal: 25,
    backgroundColor: '#333',
    borderRadius: 8,
  },
  closeFooterText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  headerContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingTop: 10,
    paddingBottom: 10,
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 18,
  },
  dateText: {
    color: '#fff',
    fontSize: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
  },
  footerContainer: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  counter: {
    color: '#fff',
    fontSize: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
  },
  downloadButton: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  downloadButtonText: {
    color: '#fff',
    fontSize: 20,
  },
});
