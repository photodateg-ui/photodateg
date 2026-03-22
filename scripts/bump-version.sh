#!/bin/bash
# バージョン一括更新スクリプト
NEW_VERSION=$1
if [ -z "$NEW_VERSION" ]; then
  echo "Usage: ./scripts/bump-version.sh v0.3.XX"
  exit 1
fi

# 全画面のBUILD_VERSIONを更新
sed -i "s/BUILD_VERSION = 'v[0-9.]*'/BUILD_VERSION = '$NEW_VERSION'/g" \
  src/screens/HomeWebScreen.js \
  src/screens/TrashWebScreen.js \
  src/screens/AlbumSelectWebScreen.js \
  src/screens/FavoritesWebScreen.js

# SESSION_STATE.mdも更新
sed -i "s/| バージョン | v[0-9.]* |/| バージョン | $NEW_VERSION |/g" SESSION_STATE.md

echo "Updated to $NEW_VERSION"
grep -h "BUILD_VERSION" src/screens/*.js | head -5
