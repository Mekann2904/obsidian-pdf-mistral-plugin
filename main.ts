import { App, Plugin, PluginSettingTab, Setting, TFile, Notice } from 'obsidian';
import { Buffer } from 'buffer';
import { Mistral } from '@mistralai/mistralai';

/**
 * OCR 結果の pages[].images[].id と、そのBase64画像データ(imageBase64)を扱う想定。
 */
interface InlineImageMap {
  [imageId: string]: string;  // 例: { "img-0.jpeg": "data:image/jpeg;base64,..." }
}

/**
 * プラグインの設定項目
 */
interface PDFToMarkdownSettings {
  // Markdownを出力するフォルダ（Vaultルートからの相対パス）空の場合はルート
  markdownOutputFolder: string;

  // 画像を保存する基準パス（Vaultルートからの相対パス）空の場合はルート
  imagesOutputFolder: string;

  // 画像フォルダ名（この名前でサブフォルダを作る）
  // デフォルトは "pdf-mistral-images"
  imagesFolderName: string;

  // Mistral API key
  mistralApiKey: string;
}

/**
 * 設定項目のデフォルト値
 */
const DEFAULT_SETTINGS: PDFToMarkdownSettings = {
  markdownOutputFolder: '',
  imagesOutputFolder: '',
  imagesFolderName: 'pdf-mistral-images',
  mistralApiKey: ''
};

export default class PDFToMarkdownPlugin extends Plugin {
  settings: PDFToMarkdownSettings;

  async onload() {
    await this.loadSettings();

    // コマンド: PDFをMarkdown（画像も出力）に変換
    this.addCommand({
      id: 'convert-pdf-to-markdown',
      name: 'Convert PDF to Markdown with images',
      callback: () => this.openFileDialogAndProcess()
    });

    // 設定タブ
    this.addSettingTab(new PDFToMarkdownSettingTab(this.app, this));
  }

  onunload() {
    // Pluginアンロード時の処理
  }

  /**
   * PDFを選択するファイルダイアログを開き、選択した複数ファイルを順次処理
   */
  async openFileDialogAndProcess() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.multiple = true;
    input.style.display = 'none';

    input.addEventListener('change', async () => {
      if (!input.files) return;
      const files = Array.from(input.files);
      new Notice(`Selected files: ${files.length}`);
      for (const file of files) {
        if (file.type !== 'application/pdf') {
          new Notice(`Skipping non-PDF file: ${file.name}`);
          continue;
        }
        new Notice(`Processing: ${file.name}`);
        try {
          await this.processPDF(file);
          new Notice(`Processed: ${file.name}`);
        } catch (err) {
          console.error(`Error processing file ${file.name}:`, err);
          new Notice(`Error processing file: ${file.name}`);
        }
      }
    });
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  }

  /**
   * Mistral APIを使ってPDFをOCRし、MarkdownファイルとJPEG画像をVaultに保存
   */
  async processPDF(file: File): Promise<void> {
    // PDF名（拡張子除去）
    const pdfBaseName = file.name.replace(/\.pdf$/i, '');

    // -------------- Markdown出力先 --------------
    const mdFolder = this.settings.markdownOutputFolder.trim();
    if (mdFolder) {
      // フォルダが指定されていれば、存在チェックと作成
      await this.createFolderIfNotExists(mdFolder);
    }

    // -------------- Mistralへのアップロード --------------
    const apiKey = this.settings.mistralApiKey.trim();
    if (!apiKey) {
      throw new Error("Mistral API key is not set in settings.");
    }
    const client = new Mistral({ apiKey });

    new Notice("Uploading PDF...");
    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    let uploaded;
    try {
      uploaded = await client.files.upload({
        file: { fileName: file.name, content: fileBuffer },
        purpose: "ocr" as any
      });
      new Notice("Upload complete");
    } catch (err) {
      console.error(`Error uploading file: ${file.name}`, err);
      throw err;
    }

    // -------------- アップロードしたファイルのSignedURL取得 --------------
    let signedUrlResponse;
    try {
      signedUrlResponse = await client.files.getSignedUrl({ fileId: uploaded.id });
    } catch (err) {
      console.error(`Error getting signed URL for file: ${file.name}`, err);
      throw err;
    }

    // -------------- OCR実行 (画像はBase64で返してもらう) --------------
    let ocrResponse;
    try {
      ocrResponse = await client.ocr.process({
        model: "mistral-ocr-latest",
        document: {
          type: "document_url",
          documentUrl: signedUrlResponse.url,
        },
        includeImageBase64: true,  // 画像をBase64形式で含む
      });
    } catch (err) {
      console.error(`Error during OCR process for file: ${file.name}`, err);
      throw err;
    }

    // -------------- 画像保存先を決定 --------------
    //  ユーザが設定した "imagesOutputFolder"（空ならルート）と
    //  "imagesFolderName" を組み合わせたフォルダを作る
    const baseFolder = this.settings.imagesOutputFolder.trim();      // 出力先 (例: "some/subfolder")
    const folderName = this.settings.imagesFolderName.trim() || "pdf-mistral-images";

    // 両方とも空の場合は "pdf-mistral-images" にしてルートに出力
    // どちらかだけ指定されている場合はそれを結合
    let finalImagesPath = "";
    if (baseFolder && folderName) {
      finalImagesPath = `${baseFolder}/${folderName}`;
    } else if (baseFolder) {
      finalImagesPath = baseFolder;
    } else {
      // baseFolderが空の場合は folderName を使う (空なら pdf-mistral-images)
      finalImagesPath = folderName || "pdf-mistral-images";
    }

    await this.createFolderIfNotExists(finalImagesPath);

    // 1) 返却されたページを順に見て、Base64画像を保存
    // 2) Markdown中の画像参照を Obsidianリンク(![[...]])に書き換え
    const finalMd = await this.combineMarkdownWithImages(
      ocrResponse, 
      pdfBaseName, 
      finalImagesPath
    );

    // -------------- Markdownをファイルとして保存 --------------
    try {
      const mdFilePath = mdFolder
        ? `${mdFolder}/${pdfBaseName}.md`
        : `${pdfBaseName}.md`; // フォルダ未指定ならルート

      await this.createOrUpdateFile(mdFilePath, finalMd);
      new Notice("Markdown saved with images");
    } catch (err) {
      console.error("Error creating or saving MD with images:", err);
    }
  }

  /**
   * OCRレスポンスを解析し、Base64画像をファイルに書き出し、
   * Markdownテキスト中の `![](imgId)` を Obsidian独自リンクに置換
   */
  async combineMarkdownWithImages(
    ocrResult: any,
    pdfBaseName: string,
    finalImagesPath: string
  ): Promise<string> {
    if (!ocrResult.pages || !Array.isArray(ocrResult.pages)) {
      new Notice("OCR result does not contain pages.");
      return "";
    }

    // ページ順にソート
    const sortedPages = ocrResult.pages.sort((a: any, b: any) => a.index - b.index);

    let combinedMarkdown = "";
    for (const page of sortedPages) {
      let md = page.markdown || "";

      // ページ内の画像を処理
      for (const imgObj of page.images || []) {
        const originalId = imgObj.id; // "img-0.jpeg" など
        const base64 = imgObj.imageBase64;

        // 画像データが空の場合スキップ
        if (!base64 || base64.endsWith("...")) {
          console.warn(`Skipping empty or placeholder image: ${originalId}`);
          continue;
        }

        // "img-0.jpeg" -> "img-0"
        const trimmedId = originalId.replace(/\.(jpg|jpeg)$/i, '');

        // ファイル名「PDF名_元のID.jpeg」(例: "2503.10635v1_img-0.jpeg")
        const imageFileName = `${pdfBaseName}_${trimmedId}.jpeg`;

        // 画像のフルパス: "finalImagesPath/2503.10635v1_img-0.jpeg"
        const imageFilePath = `${finalImagesPath}/${imageFileName}`;

        // 実際にファイルを書き込む
        await this.saveBase64Image(base64, imageFilePath);

        // Markdownテキストの参照を Obsidianリンクに変更
        // 例: "![](img-0.jpeg)" → "![[finalImagesPath/2503.10635v1_img-0.jpeg]]"
        const escapedOriginalId = originalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\!\\[[^\\]]*\\]\\((?:.*?)${escapedOriginalId}(?:.*?)\\)`, 'g');
        const obsidianLink = `![[${finalImagesPath}/${imageFileName}]]`;

        md = md.replace(regex, obsidianLink);
      }

      // ページを結合
      combinedMarkdown += md + "\n\n";
    }

    return combinedMarkdown;
  }

  /**
   * 指定フォルダが無ければ作成する
   */
  async createFolderIfNotExists(folderPath: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(folderPath))) {
      await this.app.vault.createFolder(folderPath);
    }
  }

  /**
   * 指定のファイルパスが存在すれば更新、無ければ作成
   */
  async createOrUpdateFile(filePath: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing && existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(filePath, content);
    }
  }

  /**
   * Base64文字列(形式: "data:image/jpeg;base64,...")をバイナリに変換し、Vault内に書き込む
   */
  async saveBase64Image(base64: string, filePath: string): Promise<void> {
    const matches = base64.match(/^data:image\/jpeg;base64,(.+)/);
    if (!matches || matches.length < 2) {
      console.error("Invalid Base64 image format:", base64);
      return;
    }
    const buffer = Buffer.from(matches[1], "base64");
    await this.app.vault.adapter.writeBinary(filePath, buffer);
    console.log(`Image saved: ${filePath}`);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/**
 * 設定タブ (プラグインオプション)
 */
class PDFToMarkdownSettingTab extends PluginSettingTab {
  plugin: PDFToMarkdownPlugin;

  constructor(app: App, plugin: PDFToMarkdownPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'PDF to Markdown (Inline Image) Settings' });

    // 1) Markdown出力先
    new Setting(containerEl)
      .setName('Markdown Output Folder')
      .setDesc('Folder to save the generated Markdown (relative to vault root). Empty = root')
      .addText(text => {
        text
          .setPlaceholder('e.g. PDFOut')
          .setValue(this.plugin.settings.markdownOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.markdownOutputFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // 2) 画像出力先 (ベースパス)
    new Setting(containerEl)
      .setName('Images Output Folder')
      .setDesc('Base folder path for images (relative to vault root). Empty = root')
      .addText(text => {
        text
          .setPlaceholder('e.g. MyImagesFolder')
          .setValue(this.plugin.settings.imagesOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.imagesOutputFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // 3) 画像フォルダ名
    new Setting(containerEl)
      .setName('Images Folder Name')
      .setDesc('The subfolder name for images. Default is "pdf-mistral-images"')
      .addText(text => {
        text
          .setPlaceholder('pdf-mistral-images')
          .setValue(this.plugin.settings.imagesFolderName)
          .onChange(async (value) => {
            this.plugin.settings.imagesFolderName = value.trim() || 'pdf-mistral-images';
            await this.plugin.saveSettings();
          });
      });

    // 4) Mistral API キー
    new Setting(containerEl)
      .setName('Mistral API Key')
      .setDesc('Your Mistral API key. Keep it private!')
      .addText(text => {
        text
          .setPlaceholder('Enter your Mistral API key here')
          .setValue(this.plugin.settings.mistralApiKey)
          .onChange(async (value) => {
            this.plugin.settings.mistralApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }
}