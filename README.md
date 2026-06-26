# obsidian-pdf-mistral-plugin

## 概要
このプラグインは、Obsidian上でPDFファイルをMarkdown形式に変換し、
OCR（光学文字認識）を利用してテキストと画像を抽出するためのツールです。
OCRにはMistral APIを利用し、PDF内の画像もBase64形式で保存し、
Markdown内でObsidian独自のリンク形式（![[...]]）として扱うことができます。

## 特徴
- PDFをMarkdownに変換（OCRを使用）
- 画像をBase64形式で抽出し、Obsidian Vault内に保存
- Markdownファイルに画像をObsidian独自リンク（![[...]]）として埋め込み
- Mistral APIを利用したOCR処理
- **高解像度図表抽出**（PDF.js でページを高DPIレンダリングし、Mistral の座標から図表をクロップ）
- **LaTeX数式変換**（Mistral OCR の `\( \)` / `\[ \]` を Obsidian MathJax の `$ $` / `$$ $$` に変換）
- Markdown中の画像を右クリックしてOCR結果を直下に挿入

## インストール
1. Obsidianのプラグインフォルダ (`<Vault>/.obsidian/plugins/`) に移動
2. このリポジトリをクローンまたはZIPでダウンロードし解凍
3. Obsidianのプラグイン設定で有効化

## 設定
プラグインの設定タブで以下の項目を設定できます。

| 設定項目 | 説明 |
|---|---|
| Markdown Output Folder | 変換されたMarkdownを保存するフォルダ（Vaultルートからの相対パス） |
| Images Output Folder | 画像を保存する基準パス（Vaultルートからの相対パス） |
| Images Folder Name | 画像を保存するフォルダ名（デフォルト: `pdf-mistral-images`） |
| Mistral API Key | Mistral APIのキーを設定 |
| Enable High-Resolution Figure Extraction | PDF.js でページをレンダリングし、Mistral の座標で図表を高解像度クロップする（推奨DPI区間: 150-600） |
| Image Render DPI | 高解像度抽出時のレンダリングDPI（デフォルト: 300）。「Enable High-Resolution Figure Extraction」がONのときのみ表示 |

## 使い方
1. **PDFの変換**
   - コマンドパレット（Ctrl + P）で `Convert PDF to Markdown with images` を実行
   - ファイルダイアログが開くので、PDFを選択
   - OCRが実行され、Markdownファイルが出力される

2. **出力の確認**
   - 設定したMarkdownフォルダ内に `.md` ファイルが生成される
   - 画像は設定したフォルダに保存され、Markdown内で `![[...]]` としてリンクされる

3. **Markdown中の画像をOCR**
   - 画像行を右クリックして `OCR image (Mistral)` を選択
   - 画像直下に ```text``` 形式でOCR結果が挿入される


[Youtubeで簡単なデモ: https://www.youtube.com/watch?v=JLmnChX2uIk](https://www.youtube.com/watch?v=JLmnChX2uIk)

## 注意事項
- Mistral APIの利用にはAPIキーが必要です。
- OCRの精度はMistral APIのバージョンや品質によって異なります。
- PDFの内容によっては、画像やレイアウトの崩れが発生する可能性があります。

## ライセンス
MIT License — 詳細は [LICENSE](LICENSE) およびバンドルライブラリの [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) を参照してください。

## 謝辞 / Credits
- **高解像度図表抽出** の実装は、[gyroid](https://github.com/gyroid-eth) さんのフォーク [gyroid-eth/obsidian-pdf-mistral-hires](https://github.com/gyroid-eth/obsidian-pdf-mistral-hires) のコードを参考にしています。
- 本プラグインは [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin) のスキャフォールドをベースにしています。
