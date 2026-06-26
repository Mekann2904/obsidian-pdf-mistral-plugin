// File: /Users/mekann/obsidian/.obsidian/plugins/obsidian-pdf-mistral-plugin/main.ts
// Role: Obsidianプラグインの中核。PDFをMistral OCRで解析しMarkdownと画像を生成する。
// Why: OCR処理とVault書き込み、UI/設定を一箇所で管理するため。
// Related: manifest.json, styles.css, package.json, README.md
import { App, Plugin, PluginSettingTab, Setting, TFile, TFolder, Notice, Modal, Editor, Menu, MarkdownView } from 'obsidian';
import { Buffer } from 'buffer';
import { Mistral } from '@mistralai/mistralai';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';

type PDFDocumentProxy = import('pdfjs-dist/types/src/display/api').PDFDocumentProxy;

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

interface MistralPageDimensions {
  dpi?: number;
  width?: number;
  height?: number;
}

interface MistralImage {
  id: string;
  imageBase64?: string;
  topLeftX?: number;
  topLeftY?: number;
  bottomRightX?: number;
  bottomRightY?: number;
}

interface RenderedPdfPage {
  canvas: HTMLCanvasElement;
  dimensions: MistralPageDimensions;
}

const DEFAULT_IMAGE_RENDER_DPI = 300;
const MIN_IMAGE_RENDER_DPI = 150;
const MAX_IMAGE_RENDER_DPI = 600;
const MAX_RENDER_DIMENSION = 8000;

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
const DEFAULT_SETTINGS: PDFToMarkdownSettings = {
  markdownOutputFolder: '',
  imagesOutputFolder: '',
  imagesFolderName: 'pdf-mistral-images',
  mistralApiKey: '',
  parallelProcessingLimit: 3,
  enableHighResFigures: true,
  imageRenderDPI: DEFAULT_IMAGE_RENDER_DPI,
};

export default class PDFToMarkdownPlugin extends Plugin {
  settings: PDFToMarkdownSettings;

  async onload() {
    await this.loadSettings();
    this.configurePdfWorker();

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

  configurePdfWorker(): void {
    const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    pdfjsLib.GlobalWorkerOptions.workerSrc = this.app.vault.adapter.getResourcePath(
      `${pluginDir}/pdf.worker.min.js`
    );
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

    const apiKey = this.settings.mistralApiKey.trim();
    if (!apiKey) {
      throw new Error("Mistral API key is not set in settings.");
    }
    const client = new Mistral({ apiKey });

    // 高解像度図表抽出が有効な場合のみ PDF.js でソースPDFを読み込む。
    // 無効時や読み込み失敗時は Mistral が返す画像を使用する。
    let pdfDoc: PDFDocumentProxy | null = null;
    let pdfDocDestroyed = false;
    const destroyPdfDoc = async () => {
      if (pdfDoc && !pdfDocDestroyed) {
        await pdfDoc.destroy();
        pdfDocDestroyed = true;
        pdfDoc = null;
      }
    };
    if (this.settings.enableHighResFigures) {
      try {
        this.configurePdfWorker();
        pdfDoc = await pdfjsLib.getDocument({
          data: new Uint8Array(pdfContent.slice(0))
        }).promise;
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
      finalMd = await this.combineMarkdownWithImages(ocrResponse, pdfBaseName, finalImagesPath, pdfDoc);
    } finally {
      await destroyPdfDoc();
    }

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
    const apiKey = this.settings.mistralApiKey.trim();
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
    ocrResult: any,
    pdfBaseName: string,
    finalImagesPath: string,
    pdfDoc: PDFDocumentProxy | null
  ): Promise<string> {
    if (!ocrResult.pages || !Array.isArray(ocrResult.pages) || ocrResult.pages.length === 0) {
      throw new Error("OCR result does not contain pages.");
    }
    const sortedPages = [...ocrResult.pages].sort((a: any, b: any) =>
      (this.toFiniteNumber(a.index) ?? 0) - (this.toFiniteNumber(b.index) ?? 0)
    );
    let combinedMarkdown = "";
    for (const [pageIndex, page] of sortedPages.entries()) {
      const pageNumber = typeof page.index === 'number' ? page.index : pageIndex;
      let md = page.markdown || "";
      const images = page.images || [];

      // 高解像度図表抽出のため、ページ単位で PDF.js レンダリングを1回だけ行う（座標ベースのクロップに使用）
      let renderedPage: RenderedPdfPage | null = null;
      if (pdfDoc && images.length > 0) {
        try {
          renderedPage = await this.renderPdfPage(pdfDoc, page);
        } catch (err) {
          console.error(`Error rendering PDF page ${pageNumber + 1}. Falling back to Mistral images.`, err);
        }
      }

      for (const [imageIndex, imgObj] of images.entries()) {
        const rawId = typeof imgObj.id === 'string' && imgObj.id.trim()
          ? imgObj.id.trim()
          : `img-${pageNumber}-${imageIndex}`;
        const trimmedId = this.sanitizeFileName(rawId).replace(/\.[^/.]+$/i, '');
        const baseName = trimmedId || `img-${pageNumber}-${imageIndex}`;
        const safePdfBaseName = this.sanitizeFileName(pdfBaseName);

        // 1) 高解像度クロップを優先試行（PDF.js でレンダリングしたページから座標ベースで切り出し）
        if (renderedPage) {
          const hiResFileName = `${safePdfBaseName}_${baseName}.png`;
          const hiResFilePath = `${finalImagesPath}/${hiResFileName}`;
          let savedHiRes = false;
          try {
            savedHiRes = await this.saveRenderedImageCrop(renderedPage, imgObj, hiResFilePath);
          } catch (err) {
            console.error(`Error saving high-resolution crop for image ${rawId}. Falling back to Mistral image.`, err);
          }
          if (savedHiRes) {
            if (typeof imgObj.id === 'string' && imgObj.id.trim()) {
              const escapedOriginalId = rawId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const regex = new RegExp(`\\!\\[[^\\]]*\\]\\((?:.*?)${escapedOriginalId}(?:.*?)\\)`, 'g');
              const obsidianLink = `![[${hiResFilePath.replace(/\\/g, '/')}]]`;
              md = md.replace(regex, obsidianLink);
            }
            continue;
          }
        }

        // 2) フォールバック: Mistral が返した Base64 画像を保存
        const rawBase64 = typeof imgObj.imageBase64 === 'string'
          ? imgObj.imageBase64
          : (typeof imgObj.image_base64 === 'string' ? imgObj.image_base64 : '');
        if (!rawBase64) {
          console.warn(`Image data missing for ${rawId}`);
          md = this.removeImageReference(md, rawId);
          continue;
        }
        if (rawBase64.trim().endsWith("...")) {
          console.warn(`Image data truncated for ${rawId}`);
          md = this.removeImageReference(md, rawId);
          continue;
        }
        const imageData = this.resolveOcrImageData(rawId, rawBase64);
        if (!imageData) {
          console.warn(`Invalid image data for ${rawId}`);
          md = this.removeImageReference(md, rawId);
          continue;
        }
        const imageFileName = `${safePdfBaseName}_${baseName}.${imageData.extension}`;
        const imageFilePath = `${finalImagesPath}/${imageFileName}`;
        await this.saveImageBuffer(imageData.buffer, imageFilePath);

        if (typeof imgObj.id === 'string' && imgObj.id.trim()) {
          const escapedOriginalId = rawId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\!\\[[^\\]]*\\]\\((?:.*?)${escapedOriginalId}(?:.*?)\\)`, 'g');
          const obsidianLink = `![[${imageFilePath.replace(/\\/g, '/')}]]`;
          md = md.replace(regex, obsidianLink);
        }
      }
      combinedMarkdown += md + "\n\n";
    }
    // Mistral OCR は数式を LaTeX の \( \) / \[ \] で返すが、Obsidian の MathJax は
    // $...$ / $$...$$ しか認識しないため変換する（未変換だと数式が崩れて表示される）。
    return this.convertMathDelimiters(combinedMarkdown);
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

  async renderPdfPage(pdfDoc: PDFDocumentProxy, page: any): Promise<RenderedPdfPage> {
    const pageIndex = this.toFiniteNumber(page.index);
    if (pageIndex === null) {
      throw new Error("Missing page index.");
    }

    const dimensions = page.dimensions;
    const sourceWidth = this.toFiniteNumber(dimensions?.width);
    const sourceHeight = this.toFiniteNumber(dimensions?.height);
    if (!sourceWidth || sourceWidth <= 0 || !sourceHeight || sourceHeight <= 0) {
      throw new Error("Missing Mistral page dimensions.");
    }

    const pdfPage = await pdfDoc.getPage(pageIndex + 1);
    let scale = this.getImageRenderDPI() / 72;
    let viewport = pdfPage.getViewport({ scale });
    const longest = Math.max(viewport.width, viewport.height);

    if (longest > MAX_RENDER_DIMENSION) {
      scale = scale * (MAX_RENDER_DIMENSION / longest);
      viewport = pdfPage.getViewport({ scale });
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error("Could not create canvas context.");
    }

    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    pdfPage.cleanup();

    return { canvas, dimensions };
  }

  async saveRenderedImageCrop(
    renderedPage: RenderedPdfPage,
    imgObj: any,
    filePath: string
  ): Promise<boolean> {
    const sourceWidth = this.toFiniteNumber(renderedPage.dimensions.width);
    const sourceHeight = this.toFiniteNumber(renderedPage.dimensions.height);
    const topLeftX = this.toFiniteNumber(imgObj.topLeftX);
    const topLeftY = this.toFiniteNumber(imgObj.topLeftY);
    const bottomRightX = this.toFiniteNumber(imgObj.bottomRightX);
    const bottomRightY = this.toFiniteNumber(imgObj.bottomRightY);

    if (
      !sourceWidth || sourceWidth <= 0 ||
      !sourceHeight || sourceHeight <= 0 ||
      topLeftX === null ||
      topLeftY === null ||
      bottomRightX === null ||
      bottomRightY === null
    ) {
      return false;
    }

    const sx = renderedPage.canvas.width / sourceWidth;
    const sy = renderedPage.canvas.height / sourceHeight;
    const rawX0 = Math.min(topLeftX, bottomRightX) * sx;
    const rawY0 = Math.min(topLeftY, bottomRightY) * sy;
    const rawX1 = Math.max(topLeftX, bottomRightX) * sx;
    const rawY1 = Math.max(topLeftY, bottomRightY) * sy;

    const x0 = this.clamp(Math.round(rawX0), 0, renderedPage.canvas.width);
    const y0 = this.clamp(Math.round(rawY0), 0, renderedPage.canvas.height);
    const x1 = this.clamp(Math.round(rawX1), 0, renderedPage.canvas.width);
    const y1 = this.clamp(Math.round(rawY1), 0, renderedPage.canvas.height);
    const cropWidth = x1 - x0;
    const cropHeight = y1 - y0;

    if (cropWidth < 1 || cropHeight < 1) {
      console.warn(`Skipping image with empty crop: ${imgObj.id}`);
      return false;
    }

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;

    const cropCtx = cropCanvas.getContext('2d');
    if (!cropCtx) {
      throw new Error("Could not create crop canvas context.");
    }

    cropCtx.drawImage(
      renderedPage.canvas,
      x0,
      y0,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight
    );

    const blob = await this.canvasToBlob(cropCanvas, 'image/png');
    const buffer = Buffer.from(await blob.arrayBuffer());
    await this.app.vault.adapter.writeBinary(filePath, buffer);
    console.log(`High-resolution PNG image saved: ${filePath}`);

    return true;
  }

  canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Canvas toBlob returned null."));
        }
      }, type);
    });
  }

  getImageRenderDPI(): number {
    const value = this.toFiniteNumber(this.settings.imageRenderDPI);
    if (value === null) {
      return DEFAULT_IMAGE_RENDER_DPI;
    }
    return this.clamp(Math.round(value), MIN_IMAGE_RENDER_DPI, MAX_IMAGE_RENDER_DPI);
  }

  toFiniteNumber(value: unknown): number | null {
    const numberValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }

  clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
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
    const escapedId = imageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\!\\[[^\\]]*\\]\\((?:.*?)${escapedId}(?:.*?)\\)`, 'g');
    return markdown.replace(regex, '');
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

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
                ? Math.min(Math.max(Math.round(parsed), MIN_IMAGE_RENDER_DPI), MAX_IMAGE_RENDER_DPI)
                : DEFAULT_IMAGE_RENDER_DPI;
              await this.plugin.saveSettings();
            });
        });
    }
  }
}
