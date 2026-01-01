// File: /Users/mekann/obsidian/.obsidian/plugins/obsidian-pdf-mistral-plugin/main.ts
// Role: Obsidianプラグインの中核。PDFをMistral OCRで解析しMarkdownと画像を生成する。
// Why: OCR処理とVault書き込み、UI/設定を一箇所で管理するため。
// Related: manifest.json, styles.css, package.json, README.md
import { App, Plugin, PluginSettingTab, Setting, TFile, TFolder, Notice, Modal } from 'obsidian';
import { Buffer } from 'buffer';
import { Mistral } from '@mistralai/mistralai';

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

  // Mistral API key
  mistralApiKey: string;

  // 一括処理時の最大並列実行数
  parallelProcessingLimit: number;
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

    const apiKey = this.settings.mistralApiKey.trim();
    if (!apiKey) {
      throw new Error("Mistral API key is not set in settings.");
    }
    const client = new Mistral({ apiKey });
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
        include_image_base64: true,
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
    const finalMd = await this.combineMarkdownWithImages(ocrResponse, pdfBaseName, finalImagesPath);

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
    finalImagesPath: string
  ): Promise<string> {
    if (!ocrResult.pages || !Array.isArray(ocrResult.pages) || ocrResult.pages.length === 0) {
      throw new Error("OCR result does not contain pages.");
    }
    const sortedPages = ocrResult.pages.sort((a: any, b: any) => a.index - b.index);
    let combinedMarkdown = "";
    for (const [pageIndex, page] of sortedPages.entries()) {
      const pageNumber = typeof page.index === 'number' ? page.index : pageIndex;
      let md = page.markdown || "";
      for (const [imageIndex, imgObj] of (page.images || []).entries()) {
        const rawId = typeof imgObj.id === 'string' && imgObj.id.trim()
          ? imgObj.id.trim()
          : `img-${pageNumber}-${imageIndex}`;
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
        const trimmedId = this.sanitizeFileName(rawId).replace(/\.[^/.]+$/i, '');
        const baseName = trimmedId || `img-${pageNumber}-${imageIndex}`;
        const imageFileName = `${this.sanitizeFileName(pdfBaseName)}_${baseName}.${imageData.extension}`;
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
    return combinedMarkdown;
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
  }
}
