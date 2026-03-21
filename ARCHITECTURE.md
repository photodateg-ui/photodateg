# アーキテクチャ仕様書

---

## 📸 写真一覧表示の仕組み

- **非表示 WebView を裏で常駐させる理由**：Google フォトの公式 API は写真閲覧のスコープが制限されており、一覧取得に非公式 API を使う必要がある。そのためブラウザと同じログイン状態（Cookie セッション）を維持するために WebView を動かし続けている
- **非公式 Web API とは**：Google フォトをブラウザで開いたときに裏で走っている通信をそのまま再現したもの。認証トークンではなく Cookie で動く。`googlePhotosWebApi.js` が担当
- **サムネイル URL の末尾パラメータ**：Google フォトの画像 URL は末尾のパラメータで解像度や切り抜きを指定できる。一覧表示は `=w200-h200-c`（200×200 にクロップ）、動画は `=dv`（動画ファイル本体）を使用
- **サムネイルの表示には `expo-image` を使用**：React Native 標準の `Image` よりキャッシュが高性能で、`cachePolicy="memory-disk"` でメモリとディスク両方にキャッシュする

---

## 🔍 写真詳細表示（タップして開く）

- **使用ライブラリ**：`react-native-image-zoom-viewer`（ピンチズーム・スワイプ切り替え）、`react-native-gesture-handler`（ジェスチャー制御）
- **オリジナルサイズで表示**：URL 末尾を `=d`（ダウンロード品質＝制限なし）にすることでオリジナル解像度の画像を取得
- **前後の写真をプリロード**：現在表示中の写真を中心に前後2枚ずつ（計4枚）を `Image.prefetch()` で先読み
- **動画の場合**：`=dv` URL を WebView に読み込んで再生
- **下スワイプで戻る**：`react-native-gesture-handler` の Gesture API で下方向スワイプを検知

---

## ⬇️ ダウンロード（カメラロールへ保存）

- **使用ライブラリ**：`expo-file-system`（ファイルのダウンロード・一時保存）、`expo-media-library`（カメラロールへの書き込み）
- **ファイル名**：撮影日時から `PhotoDateG_2024-01-15_12-30-00.jpg` 形式で生成
- **EXIF 情報の書き込み**：`@lodev09/react-native-exify` を使用。`DateTimeOriginal` と `DateTime` を書き込む（フォーマットは `YYYY:MM:DD HH:MM:SS`）
- **動画は EXIF 書き込みをスキップ**：EXIF は静止画専用の規格
- **処理の流れ**：一時ディレクトリにダウンロード → EXIF 書き込み → カメラロールに保存 → 一時ファイル削除

---

## ⬆️ アップロードの仕組み（2ステップ構成・変更禁止）

- **写真選択には `expo-image-picker` を使用**：複数選択可、`quality: 1`（無劣化）、`exif: true`（EXIF 情報も取得）
- **なぜ2ステップに分けるか**：Google Photos API の仕様で「アップロードとアルバム追加を同時に行う方式」はエラーになる。一度ライブラリにアップロードしてから別途アルバムに追加する2段階が唯一の正解
  - Step 3：`/v1/mediaItems:batchCreate`（albumId を渡さない）
  - Step 4：`/v1/albums/${albumId}:batchAddMediaItems`（後からアルバムに追加）
- **楽観的更新**：API の完了を待たずにアップロードした写真を即座に画面の先頭に表示
- **hasOptimisticUpdate フラグ**：アップロード直後は Google Photos API に写真がまだ反映されていないため、このフラグが `true` の間は「0件で現在表示中の写真を上書きしない」保護として機能

---

## 📅 日付問題と回避策

**問題の原因**：Google Photos API の `batchCreate` でアップロードされた写真は、EXIF が欠落していたりファイルが再エンコードされて EXIF が消えると、アップロード日時を `creationTime` として設定してしまう。

**回避策（現在の実装）**：
```javascript
await ImagePicker.launchImageLibraryAsync({
  quality: 1,   // ← 無劣化（再エンコードしない）
  exif: true,   // ← EXIF情報を保持
});
```

- `quality: 1` にすることで iOS がファイルを再エンコードせず、元の JPEG バイナリをそのままコピー
- 元の EXIF データが保持され、Google Photos が正しい撮影日を設定できる

---

## 🗑️ 削除の仕組み（変更禁止）

- **なぜ非公式 API を使うか**：Google Photos 公式 API では「このアプリがアップロードした写真しか削除できない」という制限がある。非公式 API（`moveItemsToTrash`）はその制限がなくどの写真でもゴミ箱に移せる
- **dedupKey とは**：Google フォト内部で写真を識別するキー。表示用の `mediaKey` や公式 API の `mediaItemId` とは別物で、削除 API に渡すのはこの `dedupKey` のみ
- **削除後にリロードしない理由**：削除後すぐに `onRefresh()` を呼ぶと WebView がまだ削除前のデータを返す→写真が復活→無限ループになる。そのため state から直接取り除いて完了とし、リロードは行わない

---

## 🗂️ アルバム管理の仕組み

- **APP_CREATED_ALBUMS**：このアプリで新規作成したアルバムの `apiAlbumId` を端末の AsyncStorage に保存
- **SELECTED_ALBUM**：現在選択中のアルバム情報を端末に保存
- **なぜ listAlbums API が使えないか**：Google Photos API のスコープ制限により、アルバム一覧の取得が常に 0件返る
- **Fallback 2 の役割**：アルバム選択画面でアルバムを選び直すと、`APP_CREATED_ALBUMS` が空の場合に `apiAlbumId` が null で上書きされるバグがある。これを防ぐため「同じ名前のアルバムを選んだとき、すでに保存済みの apiAlbumId をそのまま引き継ぐ」仕組み

---

## 🔄 リフレッシュの仕組み（2026-03-22 追加）

### WebView配置の注意点

- **メインreturn文にもWebViewが必要**：ローディング/エラー状態以外でもリフレッシュするため
- **WebViewは画面外に配置する**：レイアウトに影響させないため、`position: absolute, top: -9999, left: -9999` で画面外に配置
- **cacheEnabled={false}**：リフレッシュ時に最新データを取得するため、キャッシュを無効化
- **webViewKeyでWebViewを再作成**：リフレッシュ時に `setWebViewKey(prev => prev + 1)` でキーを変更し、WebViewを完全に再作成することでキャッシュ問題を回避

### アルバム削除後の挙動

- **削除後はonRefresh()を呼ばない**：写真削除と同様、WebViewキャッシュが古いデータを返すとアルバムが復活するため
- **stateから直接削除**：`setAlbums(prev => prev.filter(...))` で即座に画面から消す

---

## 🔑 認証・セッション（2本立て）

- **Google OAuth（accessToken）の役割**：公式 Google Photos API（アップロード・アルバム作成・アルバム名変更）を呼ぶための認証トークン。有効期限あり（通常1時間）
- **WebView セッション（Cookie）の役割**：非公式 API（写真一覧取得・削除）を使うための Google ログイン状態

---

## 📦 主要ライブラリ一覧

| ライブラリ | 役割 |
|------------|------|
| expo-image | 高性能キャッシュ付き画像表示 |
| react-native-webview | Google フォトの非表示セッション維持 |
| react-native-image-zoom-viewer | 詳細画面のピンチズーム・スワイプ切り替え |
| react-native-gesture-handler | 下スワイプで戻るなどのジェスチャー制御 |
| @lodev09/react-native-exify | ダウンロード時の EXIF 日時書き込み |
| expo-image-picker | アップロード用の写真・動画選択 |
| expo-file-system | ファイルのダウンロード・一時保存・削除 |
| expo-media-library | カメラロールへの保存・権限管理 |
| @react-native-async-storage/async-storage | アルバム情報・セッションの端末保存 |

---

## ⚠️ 絶対に変えてはいけない箇所

1. **performDelete の内部ロジック一切**（dedupKey の扱い・state の直接更新・リロードなし）
2. **batchCreate → batchAddMediaItems の2ステップ構成**（順番も分離も変えない）
3. **selectAlbum の Fallback 2 ブロック**（apiAlbumId の引き継ぎ）
4. **削除後の onRefresh コメントアウト**（外すと無限ループ）
5. **hasOptimisticUpdate の0件保護ロジック**（3箇所）
6. **quality: 1 と exif: true**（日付がアップロード日になる問題を防止）
7. **WebViewの画面外配置**（`top: -9999, left: -9999`、レイアウト崩れ防止）
8. **アルバム削除後のリロード禁止**（復活バグ防止）
