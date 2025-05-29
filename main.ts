import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal } from 'obsidian';
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
    // ★★★★★ ここからが修正箇所 ★★★★★
    // 安全装置：処理の最初に、同名ファイルがVault内に存在しないか最終チェック
    const targetMdName = `${pdfBaseName}.md`;
    const existingMdFile = this.app.vault.getMarkdownFiles().find(f => f.name === targetMdName);

    if (existingMdFile) {
      // ファイルが既に存在する場合、上書きを防ぐために処理を中断し、ユーザーに通知
      new Notice(`Error: "${targetMdName}" already exists. Processing stopped.`, 7000);
      return;
    }
    // ★★★★★ ここまでが修正箇所 ★★★★★

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
        includeImageBase64: true,
      });
    } catch (err) {
      console.error(`Error during OCR process for file: ${originalFileName}`, err);
      throw err;
    }
    const mdFolder = this.settings.markdownOutputFolder.trim();
    if (mdFolder) {
      await this.createFolderIfNotExists(mdFolder);
    }
    const baseFolder = this.settings.imagesOutputFolder.trim();
    const folderName = this.settings.imagesFolderName.trim() || "pdf-mistral-images";
    let finalImagesPath = "";
    if (baseFolder && folderName) {
      finalImagesPath = `${baseFolder}/${folderName}`;
    } else if (baseFolder) {
      finalImagesPath = baseFolder;
    } else {
      finalImagesPath = folderName;
    }
    await this.createFolderIfNotExists(finalImagesPath);
    const finalMd = await this.combineMarkdownWithImages(ocrResponse, pdfBaseName, finalImagesPath);

    // ファイルが存在しないことが確認済みのため、設定に基づいたパスに新規作成
    const mdFilePath = mdFolder
      ? `${mdFolder}/${targetMdName}`
      : targetMdName;
    await this.app.vault.create(mdFilePath, finalMd);
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
    if (!ocrResult.pages || !Array.isArray(ocrResult.pages)) {
      new Notice("OCR result does not contain pages.");
      return "";
    }
    const sortedPages = ocrResult.pages.sort((a: any, b: any) => a.index - b.index);
    let combinedMarkdown = "";
    for (const page of sortedPages) {
      let md = page.markdown || "";
      for (const imgObj of page.images || []) {
        const originalId = imgObj.id;
        const base64 = imgObj.imageBase64;
        if (!base64 || base64.endsWith("...")) {
          console.warn(`Skipping empty or placeholder image: ${originalId}`);
          continue;
        }
        const trimmedId = originalId.replace(/\.(jpg|jpeg)$/i, '');
        const imageFileName = `${pdfBaseName}_${trimmedId}.jpeg`;
        const imageFilePath = `${finalImagesPath}/${imageFileName}`;
        await this.saveBase64Image(base64, imageFilePath);
        const escapedOriginalId = originalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\!\\[[^\\]]*\\]\\((?:.*?)${escapedOriginalId}(?:.*?)\\)`, 'g');
        const obsidianLink = `![[${imageFilePath.replace(/\\/g, '/')}]]`;
        md = md.replace(regex, obsidianLink);
      }
      combinedMarkdown += md + "\n\n";
    }
    return combinedMarkdown;
  }

  /**
   * 指定フォルダが無ければ作成する
   */
  async createFolderIfNotExists(folderPath: string): Promise<void> {
    const cleanPath = folderPath.trim().replace(/^\/|\/$/g, '');
    if (cleanPath && !(await this.app.vault.adapter.exists(cleanPath))) {
      await this.app.vault.createFolder(cleanPath);
    }
  }

  /**
   * Base64文字列(形式: "data:image/jpeg;base64,...")をバイナリに変換し、Vault内に書き込む
   */
  async saveBase64Image(base64: string, filePath: string): Promise<void> {
    const matches = base64.match(/^data:image\/jpeg;base64,(.+)/);
    if (!matches || matches.length < 2) {
      console.error("Invalid Base64 image format (prefix missing or wrong type):", base64.substring(0, 50));
      return;
    }
    const buffer = Buffer.from(matches[1], "base64");
    await this.app.vault.adapter.writeBinary(filePath, buffer);
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

        // Vault内の全Markdownファイル名一覧を先に取得し、高速で検索できるようにSetに格納
        const allMarkdownFileNames = new Set(this.app.vault.getMarkdownFiles().map(f => f.name));

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
            // パスを構築するのではなく、ファイル名だけで存在をチェック
            const targetMdName = `${pdfFile.basename}.md`;
            const mdFileExists = allMarkdownFileNames.has(targetMdName);

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