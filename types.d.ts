// esbuild の inline-pdf-worker プラグインにより、
// pdfjs-dist/legacy/build/pdf.worker.min.js は文字列として取り込まれる。
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.js' {
	const content: string;
	export default content;
}
