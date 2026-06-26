// File: /Users/mekann/obsidian/.obsidian/plugins/obsidian-pdf-mistral-plugin/main.ts
// Role: Obsidianプラグインの中核。PDFをMistral OCRで解析しMarkdownと画像を生成する。
// Why: OCR処理とVault書き込み、UI/設定を一箇所で管理するため。
// Related: manifest.json, styles.css, package.json, README.md
import { App, Plugin, PluginSettingTab, Setting, TFile, TFolder, Notice, Modal, Editor, Menu, MarkdownView } from 'obsidian';
import { Buffer } from 'buffer';
import { Mistral } from '@mistralai/mistralai';
import {
  configurePdfWorker,
  loadPdfDocument,
  renderPdfPage,
  cropAndSaveFigure,
  clampDpi,
  DEFAULT_IMAGE_RENDER_DPI,
  MIN_IMAGE_RENDER_DPI,
  MAX_IMAGE_RENDER_DPI,
  type PDFDocumentProxy,
  type MistralOCRResult,
  type MistralPage,
  type MistralImage,
  type RenderedPdfPage,
} from './pdfjs-hires';

const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

const IMAGE_EXT_ALIASES: Record<string, string> = {
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  tiff: 'tiff',
  tif: 'tiff',
  gif: 'gif',
  bmp: 'bmp',
  svg: 'svg',
};

const normalizeVaultPath = (input: string): string => {
  return input.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
};

const parseDataUrl = (dataUrl: string): { mime: string; buffer: Buffer } | null => {
  const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (buffer.length === 0) return null;
  return { mime: match[1].toLowerCase(), buffer };
};

const extensionFromMime = (mime?: string): string | null => {
  if (!mime) return null;
  return IMAGE_MIME_TO_EXT[mime.toLowerCase()] ?? null;
};

const extensionFromImageId = (imageId: string): string | null => {
  const match = imageId.match(/\.([a-z0-9]+)$/i);
  if (!match) return null;
  return IMAGE_EXT_ALIASES[match[1].toLowerCase()] ?? null;
};

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


  // 一括処理時の最大並列実行数
  parallelProcessingLimit: number;

  // 高解像度図表抽出を有効にする（PDF.js でレンダリングして座標ベースでクロップ）
  enableHighResFigures: boolean;

  // 高解像度図表抽出時に PDF.js でページをレンダリングするDPI
  imageRenderDPI: number;
}

/**
 * 設定項目のデフォルト値
 */
const MISTRAL_API_KEY_SECRET_ID = 'pdf-mistral-plugin-mistral-api-key';

const DEFAULT_SETTINGS: PDFToMarkdownSettings = {
  markdownOutputFolder: '',
  imagesOutputFolder: '',
  imagesFolderName: 'pdf-mistral-images',
  parallelProcessingLimit: 3,
  enableHighResFigures: true,
  imageRenderDPI: DEFAULT_IMAGE_RENDER_DPI,
};

export default class PDFToMarkdownPlugin extends Plugin {
  settings: PDFToMarkdownSettings;

  async onload() {
    await this.loadSettings();

    // コマンド: PCからPDFを選択してMarkdownに変換
    this.addCommand({
      id: 'convert-pdf-to-markdown',
      name: 'Convert PDF to Markdown with images',
      callback: () => this.openFileDialogAndProcess()
    });

    // コマンド: Vault内のPDFを選択して処理するモーダルを開く
    this.addCommand({
        id: 'process-pdfs-from-vault-modal',
        name: 'Process PDFs from Vault (parallel process)',
        callback: () => {
            new PDFSelectionModal(this.app, this).open();
        }
    });

    // 設定タブ
    this.addSettingTab(new PDFToMarkdownSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
        this.addImageOcrMenuItem(menu, editor, view);
      })
    );
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
          const arrayBuffer = await file.arrayBuffer();
          const pdfBaseName = file.name.replace(/\.pdf$/i, '');
          await this.processPDFInternal(arrayBuffer, pdfBaseName, file.name);
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
   * Mistral APIを使ってPDFをOCRする共通の内部ロジック
   */
  async processPDFInternal(pdfContent: ArrayBuffer, pdfBaseName: string, originalFileName: string): Promise<void> {
    const targetMdName = `${pdfBaseName}.md`;
    const mdFolder = normalizeVaultPath(this.settings.markdownOutputFolder);
    const mdFilePath = mdFolder ? `${mdFolder}/${targetMdName}` : targetMdName;
    const mdExistsInVault = this.app.vault.getAbstractFileByPath(mdFilePath) !== null;
    const mdExistsOnDisk = await this.app.vault.adapter.exists(mdFilePath);

    if (mdExistsInVault || mdExistsOnDisk) {
      new Notice(`Error: "${mdFilePath}" already exists. Processing stopped.`, 7000);
      return;
    }

    const apiKey = this.getMistralApiKey();
    if (!apiKey) {
      throw new Error("Mistral API key is not set in settings.");
    }
    const client = new Mistral({ apiKey });

    // 高解像度図表抽出が有効な場合のみ PDF.js でソースPDFを読み込む。
    // 無効時や読み込み失敗時は Mistral が返す画像を使用する。
    let pdfDoc: PDFDocumentProxy | null = null;
    if (this.settings.enableHighResFigures) {
      try {
        configurePdfWorker();
        pdfDoc = await loadPdfDocument(new Uint8Array(pdfContent.slice(0)));
      } catch (err) {
        console.error(`Error loading PDF with pdf.js. Falling back to Mistral images: ${originalFileName}`, err);
      }
    }

    const fileBuffer = Buffer.from(pdfContent);
    let uploaded;
    try {
      uploaded = await client.files.upload({
        file: { fileName: originalFileName, content: fileBuffer },
        purpose: "ocr" as any
      });
    } catch (err) {
      console.error(`Error uploading file: ${originalFileName}`, err);
      throw err;
    }
    let signedUrlResponse;
    try {
      signedUrlResponse = await client.files.getSignedUrl({ fileId: uploaded.id });
    } catch (err) {
      console.error(`Error getting signed URL for file: ${originalFileName}`, err);
      throw err;
    }
    let ocrResponse;
    try {
      ocrResponse = await client.ocr.process({
        model: "mistral-ocr-latest",
        document: {
          type: "document_url",
          documentUrl: signedUrlResponse.url,
        },
        includeImageBase64: true,
      });
    } catch (err) {
      console.error(`Error during OCR process for file: ${originalFileName}`, err);
      throw err;
    }
    if (mdFolder) {
      await this.ensureFolderExists(mdFolder);
    }
    const baseFolder = normalizeVaultPath(this.settings.imagesOutputFolder);
    const folderName = normalizeVaultPath(this.settings.imagesFolderName) || "pdf-mistral-images";
    let finalImagesPath = "";
    if (baseFolder && folderName) {
      finalImagesPath = `${baseFolder}/${folderName}`;
    } else if (baseFolder) {
      finalImagesPath = baseFolder;
    } else {
      finalImagesPath = folderName;
    }
    await this.ensureFolderExists(finalImagesPath);
    let finalMd: string;
    try {
      finalMd = await this.combineMarkdownWithImages(ocrResponse as MistralOCRResult, pdfBaseName, finalImagesPath, pdfDoc);
    } finally {
      if (pdfDoc) await pdfDoc.destroy();
    }
    // 画像とは無関係な Markdown 後処理: Mistral の LaTeX デリミタを Obsidian (MathJax) 形式へ
    finalMd = this.convertMathDelimiters(finalMd);

    // ファイルが存在しないことが確認済みのため、設定に基づいたパスに新規作成
    try {
      await this.app.vault.create(mdFilePath, finalMd);
    } catch (err) {
      if (this.isAlreadyExistsError(err)) {
        new Notice(`Error: "${mdFilePath}" already exists. Processing stopped.`, 7000);
        return;
      }
      throw err;
    }
  }

  private addImageOcrMenuItem(menu: Menu, editor: Editor, view: MarkdownView): void {
    const cursor = editor.getCursor();
    const lineText = editor.getLine(cursor.line);
    const imageLink = this.extractImageLinkFromLine(lineText);
    if (!imageLink) return;

    menu.addItem((item) => {
      item
        .setTitle('OCR image (Mistral)')
        .setIcon('scan')
        .onClick(async () => {
          await this.handleImageOcrRequest(editor, view, cursor.line, lineText, imageLink);
        });
    });
  }

  private extractImageLinkFromLine(lineText: string): string | null {
    const embedMatch = lineText.match(/!\[\[([^\]]+)\]\]/);
    if (embedMatch) {
      const raw = embedMatch[1].trim();
      if (!raw) return null;
      return raw.split('|')[0].trim();
    }

    const markdownMatch = lineText.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (markdownMatch) {
      let raw = markdownMatch[1].trim();
      if (!raw) return null;
      raw = raw.replace(/^<(.+)>$/, '$1').trim();
      return raw.split(/\s+/)[0].trim();
    }

    return null;
  }

  private resolveImageFile(linkPath: string, view: MarkdownView): TFile | null {
    const normalized = linkPath.replace(/\\/g, '/');
    const activePath = view?.file?.path ?? '';
    const resolved = this.app.metadataCache.getFirstLinkpathDest(normalized, activePath);
    if (resolved instanceof TFile && this.isImageFile(resolved)) {
      return resolved;
    }
    const direct = this.app.vault.getAbstractFileByPath(normalized);
    if (direct instanceof TFile && this.isImageFile(direct)) {
      return direct;
    }
    return null;
  }

  private isImageFile(file: TFile): boolean {
    return Boolean(IMAGE_EXT_ALIASES[file.extension.toLowerCase()]);
  }

  private async handleImageOcrRequest(
    editor: Editor,
    view: MarkdownView,
    lineNumber: number,
    lineText: string,
    imageLink: string
  ): Promise<void> {
    if (/^https?:\/\//i.test(imageLink)) {
      new Notice('External image URLs are not supported for OCR.');
      return;
    }

    const targetFile = this.resolveImageFile(imageLink, view);
    if (!targetFile) {
      new Notice('Image file not found in vault.');
      return;
    }

    new Notice(`OCR processing: ${targetFile.name}`);

    try {
      const ocrText = await this.processImageOcr(targetFile);
      const insertion = `\n\`\`\`text\n${ocrText}\n\`\`\`\n`;
      editor.replaceRange(insertion, { line: lineNumber, ch: lineText.length });
      new Notice(`OCR complete: ${targetFile.name}`);
    } catch (err) {
      console.error('Image OCR failed:', err);
      new Notice('OCR failed. Check console for details.');
    }
  }

  private async processImageOcr(imageFile: TFile): Promise<string> {
    const apiKey = this.getMistralApiKey();
    if (!apiKey) {
      throw new Error('Mistral API key is not set in settings.');
    }
    const client = new Mistral({ apiKey });
    const arrayBuffer = await this.app.vault.readBinary(imageFile);
    const fileBuffer = Buffer.from(arrayBuffer);
    const uploaded = await client.files.upload({
      file: { fileName: imageFile.name, content: fileBuffer },
      purpose: 'ocr' as any,
    });
    const signedUrlResponse = await client.files.getSignedUrl({ fileId: uploaded.id });
    const ocrResponse = await client.ocr.process({
      model: 'mistral-ocr-latest',
      document: {
        type: 'document_url',
        documentUrl: signedUrlResponse.url,
      },
    });
    const extractedText = this.extractOcrText(ocrResponse);
    if (!extractedText) {
      throw new Error('OCR result was empty.');
    }
    return extractedText;
  }

  private extractOcrText(ocrResponse: any): string {
    if (ocrResponse?.pages && Array.isArray(ocrResponse.pages)) {
      const fragments = ocrResponse.pages
        .map((page: any) => page?.markdown || page?.text || '')
        .map((value: string) => value.trim())
        .filter(Boolean);
      if (fragments.length > 0) {
        return fragments.join('\n\n');
      }
    }
    if (typeof ocrResponse?.text === 'string' && ocrResponse.text.trim()) {
      return ocrResponse.text.trim();
    }
    return '';
  }

  /**
   * Vault内のTFileオブジェクトを処理するためのラッパー関数
   */
  async processPDFfromTFile(tfile: TFile): Promise<void> {
    new Notice(`Starting: ${tfile.name}`);
    try {
        const arrayBuffer = await this.app.vault.readBinary(tfile);
        await this.processPDFInternal(arrayBuffer, tfile.basename, tfile.name);
        new Notice(`Success: ${tfile.name}`);
    } catch(err) {
        new Notice(`Failed: ${tfile.name}. Check console for details.`);
        console.error(`Detailed error for ${tfile.name}:`, err);
        throw err;
    }
  }

  /**
   * OCRレスポンスを解析し、Base64画像をファイルに書き出し、
   * Markdownテキスト中の `![](imgId)` を Obsidian独自リンクに置換
   */
  async combineMarkdownWithImages(
    ocrResult: MistralOCRResult,
    pdfBaseName: string,
    finalImagesPath: string,
    pdfDoc: PDFDocumentProxy | null
  ): Promise<string> {
    if (!ocrResult.pages || ocrResult.pages.length === 0) {
      throw new Error("OCR result does not contain pages.");
    }
    const sortedPages = [...ocrResult.pages].sort((a, b) =>
      (Number(a?.index) || 0) - (Number(b?.index) || 0)
    );
    const safePdfBaseName = this.sanitizeFileName(pdfBaseName);
    const dpi = this.effectiveRenderDPI();
    let combinedMarkdown = "";

    for (const [pageIndex, page] of sortedPages.entries()) {
      const pageNumber = typeof page.index === 'number' ? page.index : pageIndex;
      let md = page.markdown || "";
      const images = page.images ?? [];

      // ページ単位で PDF.js レンダリングを1回だけ行う（座標ベースの高解像度クロップ用）
      let renderedPage: RenderedPdfPage | null = null;
      if (pdfDoc && images.length > 0) {
        try {
          renderedPage = await renderPdfPage(pdfDoc, page, dpi);
        } catch (err) {
          console.error(`Error rendering PDF page ${pageNumber + 1}. Falling back to Mistral images.`, err);
        }
      }

      for (const [imageIndex, imgObj] of images.entries()) {
        const rawId = typeof imgObj.id === 'string' && imgObj.id.trim()
          ? imgObj.id.trim()
          : `img-${pageNumber}-${imageIndex}`;
        const baseName = (this.sanitizeFileName(rawId).replace(/\.[^/.]+$/i, '')) || `img-${pageNumber}-${imageIndex}`;

        // 保存戦略は saveImageFor に集約（HiRes 優先 → Mistral Base64 へフォールバック）。
        // 結果は保存先パス1つだけで、リンク書き換え/参照除去は単一路に統一される。
        const savedPath = await this.saveImageFor(imgObj, safePdfBaseName, baseName, finalImagesPath, renderedPage);
        md = savedPath ? this.rewriteImageLink(md, rawId, savedPath) : this.removeImageReference(md, rawId);
      }
      combinedMarkdown += md + "\n\n";
    }
    return combinedMarkdown;
  }

  /**
   * 1枚の図表を保存する。HiRes クロップ優先 → 失敗時は Mistral の Base64 にフォールバック。
   * 保存できなかった場合は null を返し、呼び出し側に参照除去を委ねる。
   */
  private async saveImageFor(
    imgObj: MistralImage,
    safePdfBaseName: string,
    baseName: string,
    finalImagesPath: string,
    renderedPage: RenderedPdfPage | null,
  ): Promise<string | null> {
    // 1) 高解像度クロップ（PDF.js レンダリング + Mistral 座標）
    if (renderedPage) {
      const hiResFilePath = `${finalImagesPath}/${safePdfBaseName}_${baseName}.png`;
      try {
        const writeBinary = (path: string, data: Buffer) => this.saveImageBuffer(data, path);
        if (await cropAndSaveFigure(renderedPage, imgObj, hiResFilePath, writeBinary)) {
          return hiResFilePath;
        }
      } catch (err) {
        console.error(`Error saving high-resolution crop for image ${imgObj.id}. Falling back to Mistral image.`, err);
      }
    }

    // 2) フォールバック: Mistral が返した Base64 画像
    const rawBase64 = typeof imgObj.imageBase64 === 'string' ? imgObj.imageBase64 : '';
    if (!rawBase64) {
      console.warn(`Image data missing for ${imgObj.id}`);
      return null;
    }
    if (rawBase64.trim().endsWith("...")) {
      console.warn(`Image data truncated for ${imgObj.id}`);
      return null;
    }
    const imageData = this.resolveOcrImageData(imgObj.id, rawBase64);
    if (!imageData) {
      console.warn(`Invalid image data for ${imgObj.id}`);
      return null;
    }
    const imageFilePath = `${finalImagesPath}/${safePdfBaseName}_${baseName}.${imageData.extension}`;
    await this.saveImageBuffer(imageData.buffer, imageFilePath);
    return imageFilePath;
  }

  /** 設定の DPI を健全な区間に正規化する（正規実装は pdfjs-hires 側）。 */
  private effectiveRenderDPI(): number {
    const value = Number(this.settings.imageRenderDPI);
    return Number.isFinite(value) ? clampDpi(value) : DEFAULT_IMAGE_RENDER_DPI;
  }

  // LaTeX の数式デリミタを Obsidian (MathJax) 形式へ変換する。
  //   \[ ... \]  ->  $$ ... $$   (ディスプレイ数式)
  //   \( ... \)  ->  $ ... $     (インライン数式)
  // 既存のコードブロック等を壊さないよう、デリミタ記号のみを置換する。
  convertMathDelimiters(md: string): string {
    return md
      .replace(/\\\[/g, "$$$$")  // \[ -> $$
      .replace(/\\\]/g, "$$$$")  // \] -> $$
      .replace(/\\\(/g, "$$")    // \( -> $
      .replace(/\\\)/g, "$$");   // \) -> $
  }

  /** 画像参照 `![](imageId)` にマッチする正規表現を構築する（エスケープ込み）。 */
  private buildImageRefRegex(imageId: string): RegExp {
    const escapedId = imageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\!\\[[^\\]]*\\]\\((?:.*?)${escapedId}(?:.*?)\\)`, 'g');
  }

  /** Markdown 中の画像参照を Obsidian 埋め込みリンクへ書き換える。 */
  private rewriteImageLink(md: string, imageId: string, savedPath: string): string {
    return md.replace(this.buildImageRefRegex(imageId), `![[${savedPath.replace(/\\/g, '/')}]]`);
  }

  /**
   * 競合に強い形でフォルダを作成する
   */
  async ensureFolderExists(folderPath: string): Promise<void> {
    const cleanPath = normalizeVaultPath(folderPath);
    if (!cleanPath) return;
    const parts = cleanPath.split('/').filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) {
        throw new Error(`Cannot create folder because a file exists at "${current}"`);
      }
      if (existing instanceof TFolder) {
        continue;
      }
      try {
        await this.app.vault.createFolder(current);
      } catch (err) {
        if (!this.isAlreadyExistsError(err)) {
          throw err;
        }
      }
    }
  }

  /**
   * 画像バッファをVault内に書き込む
   */
  async saveImageBuffer(buffer: Buffer, filePath: string): Promise<void> {
    await this.app.vault.adapter.writeBinary(filePath, buffer);
  }

  private resolveOcrImageData(imageId: string, base64: string): { buffer: Buffer; extension: string } | null {
    const trimmedBase64 = base64.trim();
    const parsed = parseDataUrl(trimmedBase64);
    const buffer = parsed?.buffer ?? Buffer.from(trimmedBase64.replace(/\s+/g, ''), 'base64');
    if (buffer.length === 0) return null;
    const extension = extensionFromMime(parsed?.mime)
      ?? extensionFromImageId(imageId)
      ?? this.detectImageExtensionFromBuffer(buffer)
      ?? 'bin';
    return { buffer, extension };
  }

  private sanitizeFileName(input: string): string {
    // Windows予約文字と制御文字を避ける
    return input
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');
  }

  private removeImageReference(markdown: string, imageId: string): string {
    if (!imageId) return markdown;
    return markdown.replace(this.buildImageRefRegex(imageId), '');
  }

  private detectImageExtensionFromBuffer(buffer: Buffer): string | null {
    if (buffer.length < 12) return null;
    // 代表的な画像形式だけを軽く判定する
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) return 'bmp';
    if (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A) return 'tiff';
    if (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A) return 'tiff';
    if (
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) {
      return 'webp';
    }
    return null;
  }

  private isAlreadyExistsError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return message.toLowerCase().includes('already exists') || message.includes('EEXIST');
  }

  getMistralApiKey(): string {
    return this.app.secretStorage.getSecret(MISTRAL_API_KEY_SECRET_ID)?.trim() ?? '';
  }

  async loadSettings() {
    const loadedData = await this.loadData() ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);

    // 旧バージョンでは API キー本体を data.json に保存していたため、SecretStorage へ移行する。
    const legacyApiKey = typeof loadedData.mistralApiKey === 'string' ? loadedData.mistralApiKey.trim() : '';
    if (legacyApiKey && !this.getMistralApiKey()) {
      this.app.secretStorage.setSecret(MISTRAL_API_KEY_SECRET_ID, legacyApiKey);
      await this.saveSettings();
    }
  }

  async saveSettings() {
    const { mistralApiKey, mistralApiKeySecretId, ...settingsToSave } = this.settings as PDFToMarkdownSettings & { mistralApiKey?: string; mistralApiKeySecretId?: string };
    await this.saveData(settingsToSave);
  }
}

class MistralApiKeyModal extends Modal {
  private onSubmit: (apiKey: string) => Promise<void>;

  constructor(app: App, onSubmit: (apiKey: string) => Promise<void>) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Set Mistral API Key' });
    contentEl.createEl('p', { text: 'The API key will be stored in Obsidian SecretStorage, not in data.json.' });

    let apiKey = '';
    new Setting(contentEl)
      .setName('API Key')
      .addText(text => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Enter your Mistral API key')
          .onChange((value) => {
            apiKey = value.trim();
          });
      });

    new Setting(contentEl)
      .addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => this.close()))
      .addButton(button => button
        .setCta()
        .setButtonText('Save')
        .onClick(async () => {
          if (!apiKey) {
            new Notice('API key is empty.');
            return;
          }
          await this.onSubmit(apiKey);
          new Notice('Mistral API key saved.');
          this.close();
        }));
  }

  onClose() {
    this.contentEl.empty();
  }
}


/**
 * PDF選択と並列処理のためのモーダル
 */
class PDFSelectionModal extends Modal {
    plugin: PDFToMarkdownPlugin;

    constructor(app: App, plugin: PDFToMarkdownPlugin) {
        super(app);
        // --- ★★★ バグ修正: この行を追加 ★★★ ---
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        
        modalEl.style.width = 'min(90vw, 900px)';

        contentEl.createEl('h2', { text: 'Process PDFs in Vault' });
        contentEl.createEl('p', { text: `Select PDFs to process. Files will be processed in parallel. (Max concurrent tasks: ${this.plugin.settings.parallelProcessingLimit})` });

        const pdfFiles = this.app.vault.getFiles().filter(file => file.extension === 'pdf');
        if (pdfFiles.length === 0) {
            contentEl.createEl('p', { text: 'No PDF files found in your vault.' });
            return;
        }

        const mdFolder = normalizeVaultPath(this.plugin.settings.markdownOutputFolder);
        const allMarkdownFilePaths = new Set(this.app.vault.getMarkdownFiles().map(f => f.path));

        const tableContainer = contentEl.createDiv({ cls: 'pdf-list-container' });
        tableContainer.style.maxHeight = '50vh';
        tableContainer.style.overflowY = 'auto';
        tableContainer.style.border = '1px solid var(--background-modifier-border)';
        tableContainer.style.marginBottom = '1em';

        const table = tableContainer.createEl('table');
        table.style.width = '100%';
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        headerRow.createEl('th', { text: 'Select' });
        headerRow.createEl('th', { text: 'PDF File' });
        headerRow.createEl('th', { text: 'Status' });
        const tbody = table.createEl('tbody');
        const fileProcessingList: { pdfFile: TFile, checkbox: HTMLInputElement }[] = [];

        for (const pdfFile of pdfFiles) {
            const targetMdName = `${pdfFile.basename}.md`;
            const targetMdPath = mdFolder ? `${mdFolder}/${targetMdName}` : targetMdName;
            const mdFileExists = allMarkdownFilePaths.has(targetMdPath);

            const row = tbody.createEl('tr');
            const selectCell = row.createEl('td');
            if (mdFileExists) {
                selectCell.setText('生成済み');
            } else {
                const checkbox = selectCell.createEl('input', { type: 'checkbox' });
                checkbox.dataset.pdfPath = pdfFile.path;
                fileProcessingList.push({ pdfFile, checkbox });
            }
            row.createEl('td', { text: pdfFile.path });
            row.createEl('td', { text: mdFileExists ? '✔' : '未生成' });
        }

        const buttonContainer = contentEl.createDiv();
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'space-between';
        
        const selectionButtons = buttonContainer.createDiv();
        const actionButtons = buttonContainer.createDiv();

        const selectAllButton = selectionButtons.createEl('button', { text: 'Select All' });
        selectAllButton.style.marginRight = '10px';
        const deselectAllButton = selectionButtons.createEl('button', { text: 'Deselect All' });
        
        const processButton = actionButtons.createEl('button', { text: 'Process Selected PDFs', cls: 'mod-cta' });
        processButton.style.marginRight = '10px';
        const closeButton = actionButtons.createEl('button', { text: 'Close' });

        selectAllButton.addEventListener('click', () => {
            fileProcessingList.forEach(item => item.checkbox.checked = true);
        });
        deselectAllButton.addEventListener('click', () => {
            fileProcessingList.forEach(item => item.checkbox.checked = false);
        });
        closeButton.addEventListener('click', () => this.close());
        
        processButton.addEventListener('click', async () => {
            const selectedFiles = fileProcessingList
                .filter(item => item.checkbox.checked)
                .map(item => item.pdfFile);
            if (selectedFiles.length === 0) {
                new Notice('No new PDFs selected.');
                return;
            }

            processButton.disabled = true;
            selectAllButton.disabled = true;
            deselectAllButton.disabled = true;
            closeButton.disabled = true;
            processButton.setText('Processing...');
            
            const concurrencyLimit = this.plugin.settings.parallelProcessingLimit;
            const queue = [...selectedFiles];
            let successCount = 0;
            let failureCount = 0;

            new Notice(`Starting processing of ${queue.length} files with ${concurrencyLimit} parallel workers.`);

            const worker = async () => {
                while (queue.length > 0) {
                    const fileToProcess = queue.shift();
                    if (!fileToProcess) continue;

                    try {
                        await this.plugin.processPDFfromTFile(fileToProcess);
                        successCount++;
                    } catch (e) {
                        failureCount++;
                    }
                }
            };

            const workerPromises = [];
            for (let i = 0; i < concurrencyLimit; i++) {
                workerPromises.push(worker());
            }

            await Promise.all(workerPromises);

            new Notice(`Processing complete. Success: ${successCount}, Failed: ${failureCount}.`);
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
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

    new Setting(containerEl)
      .setName('Mistral API Key')
      .setDesc(this.plugin.getMistralApiKey()
        ? 'Stored in Obsidian SecretStorage. Current key is configured.'
        : 'Stored in Obsidian SecretStorage. No key configured yet.')
      .addButton(button => button
        .setButtonText(this.plugin.getMistralApiKey() ? 'Replace API key' : 'Set API key')
        .onClick(() => {
          new MistralApiKeyModal(this.app, async (apiKey) => {
            this.app.secretStorage.setSecret(MISTRAL_API_KEY_SECRET_ID, apiKey);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        }));
      
    new Setting(containerEl)
        .setName('Parallel Processing Limit')
        .setDesc('Number of files to process concurrently. Lower this if you encounter API rate limits.')
        .addText(text => {
            text
                .setPlaceholder('e.g., 3')
                .setValue(String(this.plugin.settings.parallelProcessingLimit))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.parallelProcessingLimit = num;
                        await this.plugin.saveSettings();
                    }
                });
        });

    new Setting(containerEl)
      .setName('Enable High-Resolution Figure Extraction')
      .setDesc('Render PDF pages with PDF.js and crop figures at high resolution using Mistral coordinates. When disabled, only Mistral-provided images are used.')
      .addToggle(toggle => {
        toggle
          .setValue(this.plugin.settings.enableHighResFigures)
          .onChange(async (value) => {
            this.plugin.settings.enableHighResFigures = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.enableHighResFigures) {
      new Setting(containerEl)
        .setName('Image Render DPI')
        .setDesc('DPI for rendering PDF pages before image cropping (high-resolution figures). Recommended range: 150-600')
        .addText(text => {
          text.inputEl.type = 'number';
          text.inputEl.min = String(MIN_IMAGE_RENDER_DPI);
          text.inputEl.max = String(MAX_IMAGE_RENDER_DPI);
          text.inputEl.step = '50';
          text
            .setPlaceholder(String(DEFAULT_IMAGE_RENDER_DPI))
            .setValue(String(this.plugin.settings.imageRenderDPI ?? DEFAULT_IMAGE_RENDER_DPI))
            .onChange(async (value) => {
              const parsed = Number(value);
              this.plugin.settings.imageRenderDPI = Number.isFinite(parsed)
                ? clampDpi(parsed)
                : DEFAULT_IMAGE_RENDER_DPI;
              await this.plugin.saveSettings();
            });
        });
    }
  }
}
