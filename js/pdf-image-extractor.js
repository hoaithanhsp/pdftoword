/**
 * ========================================
 * PdfImageExtractor Module
 * Extract images/figures from PDF pages using PDF.js canvas rendering
 * ========================================
 */
const PdfImageExtractor = (() => {

    /**
     * Extract page images from PDF
     * @param {ArrayBuffer} pdfData - PDF file as ArrayBuffer
     * @param {Object} options - { scale, minAreaRatio }
     * @returns {Array} Array of { pageNum, imageBlob, x, y, width, height, placeholder }
     */
    async function extractPageImages(pdfData, options = {}) {
        const { scale = 2.0, minAreaRatio = 0.015 } = options;
        const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
        const pageImages = [];

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale });

            // Render full page to canvas
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');

            await page.render({ canvasContext: ctx, viewport }).promise;

            // Get text content to find text bounding boxes
            const textContent = await page.getTextContent();
            const textBBoxes = getTextBoundingBoxes(textContent, viewport);

            // Find image regions (areas not covered by text)
            const imageRegions = detectImageRegions(canvas, textBBoxes, viewport, minAreaRatio);

            for (const region of imageRegions) {
                const blob = await cropCanvasToBlob(canvas, region);
                if (blob) {
                    pageImages.push({
                        pageNum,
                        imageBlob: blob,
                        ...region,
                        placeholder: `[IMAGE_PAGE${pageNum}_${region.id}]`
                    });
                }
            }
        }

        return pageImages;
    }

    /**
     * Get bounding boxes of all text items on page
     */
    function getTextBoundingBoxes(textContent, viewport) {
        return textContent.items.map(item => {
            const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
            const x = tx[4];
            const y = tx[5] - item.height;
            return {
                x: Math.max(0, x - 2),
                y: Math.max(0, y - 2),
                // Add padding
                width: item.width + 4,
                height: item.height + 4
            };
        });
    }

    /**
     * Detect image regions by finding large non-text areas
     * Uses a grid-based approach to find connected non-text regions
     */
    function detectImageRegions(canvas, textBBoxes, viewport, minAreaRatio) {
        const W = canvas.width;
        const H = canvas.height;
        const minArea = W * H * minAreaRatio;

        // Create text mask (mark cells covered by text)
        const GRID = 8; // pixels per cell
        const cols = Math.ceil(W / GRID);
        const rows = Math.ceil(H / GRID);
        const textMask = new Uint8Array(cols * rows);

        textBBoxes.forEach(({ x, y, width, height }) => {
            const c0 = Math.floor(x / GRID);
            const c1 = Math.ceil((x + width) / GRID);
            const r0 = Math.floor(y / GRID);
            const r1 = Math.ceil((y + height) / GRID);
            for (let r = r0; r < r1; r++) {
                for (let c = c0; c < c1; c++) {
                    if (r >= 0 && r < rows && c >= 0 && c < cols) {
                        textMask[r * cols + c] = 1;
                    }
                }
            }
        });

        // Detect non-white, non-text regions using pixel data
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, W, H);
        const pixels = imageData.data;
        const contentMask = new Uint8Array(cols * rows);

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (textMask[r * cols + c]) continue;

                // Sample center pixel of cell
                const px = Math.min(c * GRID + GRID / 2, W - 1);
                const py = Math.min(r * GRID + GRID / 2, H - 1);
                const idx = (Math.floor(py) * W + Math.floor(px)) * 4;
                const R = pixels[idx], G = pixels[idx + 1], B = pixels[idx + 2];

                // Mark as content if not near-white
                if (R < 240 || G < 240 || B < 240) {
                    contentMask[r * cols + c] = 1;
                }
            }
        }

        // Find connected components (flood fill)
        const visited = new Uint8Array(cols * rows);
        const regions = [];
        let regionId = 0;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (!contentMask[r * cols + c] || visited[r * cols + c]) continue;

                // BFS flood fill
                const queue = [[r, c]];
                visited[r * cols + c] = 1;
                let minR = r, maxR = r, minC = c, maxC = c;
                let cellCount = 0;

                while (queue.length > 0) {
                    const [cr, cc] = queue.shift();
                    cellCount++;
                    minR = Math.min(minR, cr); maxR = Math.max(maxR, cr);
                    minC = Math.min(minC, cc); maxC = Math.max(maxC, cc);

                    const neighbors = [[cr - 1, cc], [cr + 1, cc], [cr, cc - 1], [cr, cc + 1]];
                    for (const [nr, nc] of neighbors) {
                        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols
                            && contentMask[nr * cols + nc] && !visited[nr * cols + nc]) {
                            visited[nr * cols + nc] = 1;
                            queue.push([nr, nc]);
                        }
                    }
                }

                const area = cellCount * GRID * GRID;
                if (area >= minArea) {
                    const padding = GRID * 2;
                    regions.push({
                        id: ++regionId,
                        x: Math.max(0, minC * GRID - padding),
                        y: Math.max(0, minR * GRID - padding),
                        width: Math.min(W, (maxC - minC + 1) * GRID + padding * 2),
                        height: Math.min(H, (maxR - minR + 1) * GRID + padding * 2)
                    });
                }
            }
        }

        return regions;
    }

    /**
     * Crop canvas region to PNG Blob
     */
    async function cropCanvasToBlob(canvas, { x, y, width, height }) {
        const offscreen = document.createElement('canvas');
        offscreen.width = width;
        offscreen.height = height;
        const ctx = offscreen.getContext('2d');
        ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);

        return new Promise(resolve => {
            offscreen.toBlob(blob => resolve(blob), 'image/png', 0.95);
        });
    }

    /**
     * Convert Blob to ArrayBuffer (for docx ImageRun)
     */
    async function blobToArrayBuffer(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(blob);
        });
    }

    return { extractPageImages, blobToArrayBuffer };
})();
