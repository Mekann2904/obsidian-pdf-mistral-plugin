import { App, Plugin, PluginSettingTab, Setting, TFile, TFolder, Notice } from 'obsidian';
import { Buffer } from 'buffer';
import { Mistral } from '@mistralai/mistralai';

/**
 * OCR 結果の pages[].images[].id に対応する画像IDと、
 * それを base64 inline で差し替えるためのマッピングを作る想定。
 */
interface InlineImageMap {
  [imageId: string]: string; // 例: { "img-0.jpeg": "data:image/jpeg;base64,/9j/4AAQ..."}
}

function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface PDFToMarkdownSettings {
	markdownOutputFolder: string;
	mistralApiKey: string;
}

const DEFAULT_SETTINGS: PDFToMarkdownSettings = {
	markdownOutputFolder: '',
	mistralApiKey: ''
};

export default class PDFToMarkdownPlugin extends Plugin {
	settings: PDFToMarkdownSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'convert-pdf-to-markdown',
			name: 'Convert PDF to Markdown with inline images',
			callback: () => this.openFileDialogAndProcess()
		});

		this.addSettingTab(new PDFToMarkdownSettingTab(this.app, this));
	}

	onunload() {
		// プラグイン破棄時の処理
	}

	/**
	 * PDF選択ダイアログを開き、選択した複数ファイルを処理
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
	 * PDFをアップロードしOCR→Markdown化
	 */
	async processPDF(file: File): Promise<void> {
		const pdfBaseName = file.name.replace(/\.pdf$/i, '');
		const mdFolder = this.settings.markdownOutputFolder || '';
		if (mdFolder) {
			await this.createFolderIfNotExists(mdFolder);
		}

		const apiKey = this.settings.mistralApiKey;
		if (!apiKey) throw new Error("Mistral API key is not set in settings.");
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
			console.log("Uploaded file:", uploaded);
		} catch (err) {
			console.error(`Error uploading file: ${file.name}`, err);
			throw err;
		}

		let signedUrlResponse;
		try {
			new Notice("Getting signed URL...");
			signedUrlResponse = await client.files.getSignedUrl({ fileId: uploaded.id });
			new Notice("Signed URL obtained");
			console.log("Signed URL response:", signedUrlResponse);
		} catch (err) {
			console.error(`Error getting signed URL for file: ${file.name}`, err);
			throw err;
		}

		let ocrResponse;
		try {
			new Notice("Processing OCR...");
			ocrResponse = await client.ocr.process({
				model: "mistral-ocr-latest",
				document: {
					type: "document_url",
					documentUrl: signedUrlResponse.url,
				},
				includeImageBase64: true,
			});
			new Notice("OCR processing complete");
			console.log("OCR Response:", ocrResponse);
		} catch (err) {
			console.error(`Error during OCR process for file: ${file.name}`, err);
			throw err;
		}

		// JSON保存 (任意)
		try {
			const jsonContent = JSON.stringify(ocrResponse, null, 2);
			const jsonPath = mdFolder ? `${mdFolder}/${pdfBaseName}.json` : `${pdfBaseName}.json`;
			await this.createOrUpdateFile(jsonPath, jsonContent);
			new Notice("JSON result saved");
		} catch (err) {
			console.error("Error saving JSON result:", err);
		}

		// 画像データはファイルに保存せず、そのまま base64 埋め込みする
		let finalMd;
		try {
			finalMd = this.combineMarkdownInlineImages(ocrResponse);
			const mdPath = mdFolder ? `${mdFolder}/${pdfBaseName}.md` : `${pdfBaseName}.md`;
			await this.createOrUpdateFile(mdPath, finalMd);
			new Notice("Markdown saved (inline images)");
		} catch (err) {
			console.error("Error creating or saving MD with inline images:", err);
		}
	}

	/**
	 * 指定フォルダが無ければ作成
	 */
	async createFolderIfNotExists(folderPath: string): Promise<void> {
		if (!(await this.app.vault.adapter.exists(folderPath))) {
			await this.app.vault.createFolder(folderPath);
		}
	}

	/**
	 * 指定ファイルパスが既にあれば更新、無ければ作成
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
	 * OCRの pages[] を走査し、page.markdown の中の `![](img-xx.jpeg)` を
	 * そのまま `![](data:image/...base64,xxxx)` に置換して結合する。
	 */
	combineMarkdownInlineImages(ocrResult: any): string {
		if (!ocrResult.pages || !Array.isArray(ocrResult.pages)) {
			new Notice("OCR result does not contain pages.");
			return "";
		}
		// ページ順に並べる
		const sortedPages = ocrResult.pages.sort((a: any, b: any) => a.index - b.index);

		let combined = "";
		for (const page of sortedPages) {
			let md = page.markdown || "";
			// images[] があるなら、対応表を作る
			const inlineMap: InlineImageMap = {};
			if (page.images && Array.isArray(page.images)) {
				for (const imgObj of page.images) {
					const imgId = imgObj.id; // "img-0.jpeg" など
					const base64 = imgObj.imageBase64; // "data:image/jpeg;base64,xxx"
					if (!base64 || base64.endsWith("...")) {
						console.warn(`Image ${imgId} is empty or placeholder.`);
						continue;
					}
					inlineMap[imgId] = base64;
				}
			}
			// md 内の画像参照を inline base64 に変換
			for (const [imgId, dataUrl] of Object.entries(inlineMap)) {
				const escapedId = escapeRegExp(imgId);
				// 例: ![](img-0.jpeg) とか ![タイトル](img-0.jpeg)
				const regex = new RegExp(`\\!\\[([^\\]]*)\\]\\(([^)]*${escapedId}[^)]*)\\)`, 'g');
				md = md.replace(regex, (match: string, altText: string) => {
					return `![${altText}](${dataUrl})`;
				});
			}
			combined += md + "\n\n";
		}
		return combined;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

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
			.setDesc('If empty, saved at vault root')
			.addText(text => {
				text.setPlaceholder('Example: PDFOut');
				text.setValue(this.plugin.settings.markdownOutputFolder);
				text.onChange(async (value) => {
					this.plugin.settings.markdownOutputFolder = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Mistral API Key')
			.setDesc('Mistral OCR API Key')
			.addText(text => {
				text.setPlaceholder('Enter Mistral API Key');
				text.setValue(this.plugin.settings.mistralApiKey);
				text.onChange(async (value) => {
					this.plugin.settings.mistralApiKey = value;
					await this.plugin.saveSettings();
				});
			});
	}
}
