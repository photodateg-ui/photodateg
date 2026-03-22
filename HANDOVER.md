# PhotoDateG ゴミ箱機能 引き継ぎ（2026-03-23）

## 現在の状態
- **バージョン**: v0.3.115
- **サムネイル表示**: ✅ 動作する（パターン1でマッチ）
- **復元機能**: ❌ 動作しない（dedupKeyが取得できていない）

## 問題の詳細

### サムネイル表示（解決済み）
- パターン1 `/\\["(AF1Qip[A-Za-z0-9_-]+)",\\s*\\["(https:\\/\\/[^"]+)"/g` でマッチ
- v0.3.94のコードベースで動作確認済み
- 53件のアイテムを正常に取得

### 復元機能（未解決）
- 復元には `dedupKey` が必要
- 現在のdedupKey抽出ロジックが動作しない
- 原因: ゴミ箱データの実際の構造が不明

## ゴミ箱ページのデータ構造

### 観察結果
1. `ds:0` - アルバム一覧データ（`スクリーンショットと録画`, `メモ`, `レシピ、メニュー`等）
2. `ds:1` - ユーザー情報（プロフィール画像等）
3. ゴミ箱アイテム自体のデータ - パターン1でマッチするが、dedupKeyの位置が不明

### パターン1でマッチするデータ形式
```
["AF1Qip...",["https://lh3.googleusercontent.com/..."
```
しかし、後続のdedupKey位置が以前の想定と異なる可能性。

## 次のステップ

### 1. データ構造の調査
PCでGoogle Photos（https://photos.google.com/trash）を開き、DevToolsで:
1. ネットワークタブでbatchexecuteリクエストを確認
2. ページ内のスクリプトで実際のゴミ箱アイテムのデータ構造を確認
3. dedupKeyがどこにあるか特定

### 2. 調査のヒント
- サンプル取得を改善（パターン1でマッチした位置周辺を出力）
- ゴミ箱ページのスクリプト全体をダンプしてローカルで分析

### 3. 代替アプローチ
- API方式（RPC）でゴミ箱アイテムを取得（現在HTTP 400エラー、RPC IDが古い可能性）
- RPC_IDS.GET_TRASH_ITEMS: `zy0lHe` の更新が必要かも

## 関連ファイル

### 主要ファイル
- `src/screens/TrashWebScreen.js` - ゴミ箱画面、スクリプト注入
- `src/services/googlePhotosWebApi.js` - API呼び出し、`getTrashItems`関数
- `src/services/googleAuthService.js` - デバッグログ出力

### 設定
- デバッグメニュー: タイトル3回タップで開く（`HomeWebScreen.js`, `AlbumSelectWebScreen.js`）

## 今夜の作業履歴

### 問題発生
- v0.3.99でゴミ箱が空になる問題が報告された
- 原因: Googleのデータ構造変更？

### 試したこと
1. v0.3.100-109: 様々なパターンマッチ修正 → サムネイル黒、またはクルクルでフリーズ
2. v0.3.110: v0.3.94ベースに戻す → サムネイル表示復活
3. v0.3.111-115: dedupKey抽出追加 → パターン1を壊さずに追加したが、抽出できず

### 結論
- サムネイル表示: v0.3.94のパターン1で動作
- dedupKey: データ構造の調査が必要

## コマンド

### OTA配布
```bash
cd /home/riichi/works/photov
EXPO_TOKEN=lCnYEIhWs0D11Bj9QOU2xFPfcBRL_9uOcgeTpkNh eas update --channel production --message "メッセージ" --non-interactive
```

### バージョン更新
```bash
./scripts/bump-version.sh v0.3.XXX
```

### git操作
```bash
# v0.3.94のTrashWebScreen.jsに戻す
git checkout 1e495c1 -- src/screens/TrashWebScreen.js
```
