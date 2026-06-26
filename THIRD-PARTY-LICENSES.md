# Third-Party Licenses

このプラグインは、以下のサードパーティライブラリを `main.js` にバンドルしています。
それぞれのライセンスを以下に示します。

| Library | Version | License | Project |
|---|---|---|---|
| pdfjs-dist (pdf.js) | 3.11.174 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| @mistralai/mistralai | ^1.5.1 | Apache-2.0 | https://github.com/mistralai/client-ts |

> 注: pdf.js のワーカーコード (`pdf.worker.min.js`) は配布時に別ファイルとして
> 同梱するのではなく、**`main.js` 内にインライン埋め込み** し、実行時に Blob URL として
> 読み込んでいます。そのため配布ファイルは `main.js` + `manifest.json` の2つだけで動作します。

## Apache-2.0 (pdf.js, @mistralai/mistralai)

Licensed under the Apache License, Version 2.0. You may obtain a copy of the
License at <http://www.apache.org/licenses/LICENSE-2.0>.

pdf.js 関連のコード (`main.js` にコンパイルされた pdf.js 本体およびインライン化された
ワーカー) は © Mozilla Foundation and contributors であり、Apache-2.0 で配布されています。

---

## 謝辞 / Credits

- **高解像度図表抽出** の実装は、[gyroid](https://github.com/gyroid-eth) さんの
  フォーク [gyroid-eth/obsidian-pdf-mistral-hires](https://github.com/gyroid-eth/obsidian-pdf-mistral-hires)
  のコードを参考にしています。
- 本プラグインは [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
  のスキャフォールドをベースにしています。

This project itself is licensed under the MIT License — see [LICENSE](LICENSE).
