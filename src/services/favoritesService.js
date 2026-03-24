import AsyncStorage from '@react-native-async-storage/async-storage';

const FAVORITES_KEY = '@photov_favorites';

/**
 * お気に入り一覧を取得
 * @returns {Promise<Array>} favoritePhoto[]
 */
export async function getFavorites() {
  try {
    const stored = await AsyncStorage.getItem(FAVORITES_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * 写真がお気に入りかどうか確認
 * @param {string} mediaKey
 * @returns {Promise<boolean>}
 */
export async function isFavorite(mediaKey) {
  const favorites = await getFavorites();
  return favorites.some(f => f.mediaKey === mediaKey);
}

/**
 * お気に入りに追加
 * @param {{ mediaKey, thumb, timestamp, dedupKey }} photo
 */
export async function addFavorite(photo) {
  const favorites = await getFavorites();
  if (favorites.some(f => f.mediaKey === photo.mediaKey)) return;
  const updated = [{ mediaKey: photo.mediaKey, thumb: photo.thumb, timestamp: photo.timestamp, dedupKey: photo.dedupKey || null }, ...favorites];
  await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
}

/**
 * お気に入りから削除
 * @param {string} mediaKey
 */
export async function removeFavorite(mediaKey) {
  const favorites = await getFavorites();
  const updated = favorites.filter(f => f.mediaKey !== mediaKey);
  await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(updated));
}
