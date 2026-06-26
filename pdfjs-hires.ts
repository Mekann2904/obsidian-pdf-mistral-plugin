// File: /Users/mekann/obsidian/.obsidian/plugins/obsidian-pdf-mistral-plugin/pdfjs-hires.ts
// Role: 高解像度図表抽出エンジン。PDF.js でページをレンダリングし、
//       Mistral が返した図表座標で高解像度クロップを生成する。
// Why: pdf.js への依存とレンダリング/クロップの関心事を main.ts から隔離し、
//      plugin 本体を Vault/OCR 編成だけに専念させるため。
// Related: main.ts

import { Buffer } from 'buffer';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import workerCode from 'pdfjs-dist/legacy/build/pdf.worker.min.js';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';

export type { PDFDocumentProxy };

// ----- Mistral OCR レスポンスの型契約（HiRes パスが消費する部分） -----

export interface MistralPageDimensions {
  dpi?: number;
  width?: number;
  height?: number;
}

export interface MistralImage {
  id: string;
  imageBase64?: string;
  topLeftX?: number;
  topLeftY?: number;
  bottomRightX?: number;
  bottomRightY?: number;
}

export interface MistralPage {
  index: number;
  markdown?: string;
  dimensions?: MistralPageDimensions;
  images?: MistralImage[];
}

export interface MistralOCRResult {
  pages?: MistralPage[];
}

// ----- HiRes レンダリング設定 -----

export interface RenderedPdfPage {
  canvas: HTMLCanvasElement;
  dimensions: MistralPageDimensions;
}

export const DEFAULT_IMAGE_RENDER_DPI = 300;
export const MIN_IMAGE_RENDER_DPI = 150;
export const MAX_IMAGE_RENDER_DPI = 600;

const MAX_RENDER_DIMENSION = 8000;

/** 設定値を健全な DPI 区間に丸める（保存時・使用時の単一の正規実装）。 */
export function clampDpi(value: number): number {
  return clamp(Math.round(value), MIN_IMAGE_RENDER_DPI, MAX_IMAGE_RENDER_DPI);
}

/**
 * PDF.js ワーカーを設定する。外部ファイルではなく、インライン埋め込みした
 * worker コードから Blob URL を生成して使う。これにより配布ファイルを
 * main.js + manifest.json の2つだけにでき、pdf.worker.min.js の別途配置が不要になる。
 */
export function configurePdfWorker(): void {
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
}

/** PDF バイト列から PDFDocumentProxy を読み込む（呼び出し側が destroy を所有する）。 */
export async function loadPdfDocument(data: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data }).promise;
}

/**
 * 指定DPIでページ全体をキャンバスにレンダリングする。極端に大きいページは
 * MAX_RENDER_DIMENSION に収まるよう縮小する。戻り値はクロップ元として使われる。
 */
export async function renderPdfPage(
  pdfDoc: PDFDocumentProxy,
  page: MistralPage,
  dpi: number
): Promise<RenderedPdfPage> {
  const pageIndex = toFiniteNumber(page.index);
  if (pageIndex === null) {
    throw new Error("Missing page index.");
  }

  const dimensions = page.dimensions;
  if (!dimensions) {
    throw new Error("Missing Mistral page dimensions.");
  }
  const sourceWidth = toFiniteNumber(dimensions.width);
  const sourceHeight = toFiniteNumber(dimensions.height);
  if (!sourceWidth || sourceWidth <= 0 || !sourceHeight || sourceHeight <= 0) {
    throw new Error("Missing Mistral page dimensions.");
  }

  const pdfPage = await pdfDoc.getPage(pageIndex + 1);
  let scale = dpi / 72;
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

/**
 * レンダリング済みページから Mistral の図表座標を用いてクロップ PNG を生成し、
 * writeBinary コールバックで Vault に保存する。座標が欠落/無効なら false を返し、
 * 呼び出し側に Mistral 画像へのフォールバックを委ねる。
 */
export async function cropAndSaveFigure(
  renderedPage: RenderedPdfPage,
  img: MistralImage,
  filePath: string,
  writeBinary: (path: string, data: Buffer) => Promise<void>
): Promise<boolean> {
  const sourceWidth = toFiniteNumber(renderedPage.dimensions.width);
  const sourceHeight = toFiniteNumber(renderedPage.dimensions.height);
  const topLeftX = toFiniteNumber(img.topLeftX);
  const topLeftY = toFiniteNumber(img.topLeftY);
  const bottomRightX = toFiniteNumber(img.bottomRightX);
  const bottomRightY = toFiniteNumber(img.bottomRightY);

  if (
    !sourceWidth || sourceWidth <= 0 ||
    !sourceHeight || sourceHeight <= 0 ||
    topLeftX === null || topLeftY === null ||
    bottomRightX === null || bottomRightY === null
  ) {
    return false;
  }

  const sx = renderedPage.canvas.width / sourceWidth;
  const sy = renderedPage.canvas.height / sourceHeight;
  const x0 = clamp(Math.round(Math.min(topLeftX, bottomRightX) * sx), 0, renderedPage.canvas.width);
  const y0 = clamp(Math.round(Math.min(topLeftY, bottomRightY) * sy), 0, renderedPage.canvas.height);
  const x1 = clamp(Math.round(Math.max(topLeftX, bottomRightX) * sx), 0, renderedPage.canvas.width);
  const y1 = clamp(Math.round(Math.max(topLeftY, bottomRightY) * sy), 0, renderedPage.canvas.height);
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;

  if (cropWidth < 1 || cropHeight < 1) {
    console.warn(`Skipping image with empty crop: ${img.id}`);
    return false;
  }

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropWidth;
  cropCanvas.height = cropHeight;

  const cropCtx = cropCanvas.getContext('2d');
  if (!cropCtx) {
    throw new Error("Could not create crop canvas context.");
  }

  cropCtx.drawImage(renderedPage.canvas, x0, y0, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  const blob = await canvasToBlob(cropCanvas, 'image/png');
  await writeBinary(filePath, Buffer.from(await blob.arrayBuffer()));
  console.log(`High-resolution PNG image saved: ${filePath}`);

  return true;
}

// ----- 内部ユーティリティ -----

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      blob ? resolve(blob) : reject(new Error("Canvas toBlob returned null."));
    }, type);
  });
}
