import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useFocusEffect } from '@react-navigation/native';
import { getPhotoUrl } from '../services/googlePhotosWebApi';
import { getFavorites, removeFavorite } from '../services/favoritesService';

const SCREEN_WIDTH = Dimensions.get('window').width;
const NUM_COLUMNS = 3;
const ITEM_SIZE = SCREEN_WIDTH / NUM_COLUMNS;

/**
 * お気に入り画面
 *
 * PhotoDetailWebScreenでスターした写真の一覧を表示
 */
export default function FavoritesWebScreen({ navigation, route }) {
  const sessionData = route?.params?.sessionData || null;

  const [items, setItems] = useState([]);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState(new Set());

  // 画面フォーカス時に毎回リロード
  const loadFavorites = useCallback(async () => {
    const favorites = await getFavorites();
    setItems(favorites);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadFavorites();
    }, [loadFavorites])
  );

  const toggleSelection = useCallback((mediaKey) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(mediaKey)) {
        next.delete(mediaKey);
      } else {
        next.add(mediaKey);
      }
      return next;
    });
  }, []);

  const deleteSelected = useCallback(async () => {
    for (const key of selectedKeys) {
      await removeFavorite(key);
    }
    setSelectedKeys(new Set());
    setIsSelectionMode(false);
    loadFavorites();
  }, [selectedKeys]);

  const renderItem = useCallback(({ item, index }) => {
    const thumbUrl = getPhotoUrl(item.thumb, 200, 200, true);
    const isSelected = selectedKeys.has(item.mediaKey);

    return (
      <TouchableOpacity
        style={[styles.imageContainer, isSelected && styles.imageContainerSelected]}
        onPress={() => {
          if (isSelectionMode) {
            toggleSelection(item.mediaKey);
          } else {
            navigation.navigate('PhotoDetailWeb', {
              photos: items,
              initialIndex: index,
              sessionData,
            });
          }
        }}
        onLongPress={() => {
          if (!isSelectionMode) {
            setIsSelectionMode(true);
            toggleSelection(item.mediaKey);
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
          <View style={[styles.selectionIndicator, isSelected && styles.selectionIndicatorSelected]}>
            {isSelected && <Text style={styles.checkmark}>✓</Text>}
          </View>
        )}
        <TouchableOpacity
          style={styles.starBadge}
          onPress={async (e) => {
            e.stopPropagation?.();
            await removeFavorite(item.mediaKey);
            loadFavorites();
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.starBadgeText}>★</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  }, [isSelectionMode, selectedKeys, items, navigation, sessionData, toggleSelection, loadFavorites]);

  return (
    <SafeAreaView style={styles.container}>
      {/* ヘッダー */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Text style={styles.backButtonText}>← 戻る</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>★ お気に入り</Text>
        <View style={styles.headerRight}>
          {isSelectionMode ? (
            <TouchableOpacity onPress={() => { setIsSelectionMode(false); setSelectedKeys(new Set()); }} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>キャンセル</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => setIsSelectionMode(true)} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>選択</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {items.length === 0 ? (
        <View style={styles.centerContent}>
          <Text style={styles.emptyText}>お気に入りはまだありません</Text>
          <Text style={styles.emptySubtext}>写真を開いて ☆ をタップすると追加できます</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.mediaKey}
          renderItem={renderItem}
          numColumns={NUM_COLUMNS}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* 選択モード削除ボタン */}
      {isSelectionMode && selectedKeys.size > 0 && (
        <View style={styles.selectionFooter}>
          <Text style={styles.selectionCount}>{selectedKeys.size}枚選択中</Text>
          <TouchableOpacity onPress={deleteSelected} style={styles.deleteButton}>
            <Text style={styles.deleteButtonText}>お気に入りから削除</Text>
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
    paddingHorizontal: 32,
  },
  emptyText: {
    color: '#888',
    fontSize: 16,
    textAlign: 'center',
  },
  emptySubtext: {
    color: '#aaa',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  listContent: {
    paddingBottom: 80,
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
  starBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
  },
  starBadgeText: {
    color: '#FFD700',
    fontSize: 14,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 2,
  },
  selectionIndicator: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
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
  deleteButton: {
    backgroundColor: '#cc3333',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  deleteButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
});
