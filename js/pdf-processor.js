/**
 * ========================================
 * PDF Processor Module
 * Trích xuất text từ PDF dùng PDF.js
 * OCR cho PDF ảnh dùng Tesseract.js
 * ========================================
 */

const PdfProcessor = (() => {
    // PDF.js worker
    let pdfjsInitialized = false;

    function initPdfJs() {
        if (!pdfjsInitialized && typeof pdfjsLib !== 'undefined') {
            pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs';
            pdfjsInitialized = true;
        }
    }

    /**
     * Đọc file thành ArrayBuffer
     */
    function readFileAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Không thể đọc file'));
            reader.readAsArrayBuffer(file);
        });
    }

    // ====================================================
    // IMAGE EXTRACTION ENGINE (CORE - NEW)
    // ====================================================

    /**
     * Render một trang PDF ra canvas và trả về canvas + page object
     */
    async function renderPageToCanvas(page, scale = 2.0) {
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        return { canvas, viewport, ctx };
    }

    /**
     * Lấy bounding boxes của tất cả text items trên trang
     * Trả về mảng { x, y, w, h } theo tọa độ canvas (đã scale)
     */
    function getTextBoxes(textContent, viewport) {
        const boxes = [];
        for (const item of textContent.items) {
            if (!item.str || !item.str.trim()) continue;
            const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
            // tx[4] = x, tx[5] = y (bottom-left của text)
            const x = tx[4];
            const y = tx[5] - Math.abs(item.height * viewport.scale);
            const w = Math.abs(item.width * viewport.scale);
            const h = Math.abs(item.height * viewport.scale) + 4;
            if (w > 0 && h > 0) {
                boxes.push({ x: x - 2, y: y - 2, w: w + 4, h: h + 4 });
            }
        }
        return boxes;
    }

    /**
     * Kiểm tra pixel có phải "nền trắng/sáng" không
     */
    function isWhitePixel(r, g, b, threshold = 245) {
        return r >= threshold && g >= threshold && b >= threshold;
    }

    /**
     * Kiểm tra một ô grid có nằm trong vùng text không
     */
    function isCoveredByText(cx, cy, cw, ch, textBoxes) {
        for (const box of textBoxes) {
            // Overlap check
            if (cx < box.x + box.w && cx + cw > box.x &&
                cy < box.y + box.h && cy + ch > box.y) {
                return true;
            }
        }
        return false;
    }

    /**
     * CORE: Phát hiện vùng hình ảnh trên canvas bằng cách:
     * 1. Tạo grid mask
     * 2. Đánh dấu ô có pixel không trắng và không phải text
     * 3. Flood fill để gom các ô liền kề thành region
     * 4. Lọc region đủ lớn
     */
    function detectImageRegions(canvas, textBoxes, options = {}) {
        const {
            gridSize = 6,           // pixels per grid cell
            minWidthPx = 60,        // min width của region (pixels)
            minHeightPx = 40,       // min height của region (pixels)
            minAreaRatio = 0.008,   // min area so với toàn trang
            paddingPx = 10,         // padding quanh region khi crop
            whiteThreshold = 240    // ngưỡng màu trắng
        } = options;

        const W = canvas.width;
        const H = canvas.height;
        const minArea = W * H * minAreaRatio;

        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, W, H);
        const pixels = imageData.data; // RGBA flat array

        const cols = Math.ceil(W / gridSize);
        const rows = Math.ceil(H / gridSize);

        // Bước 1: Tạo content mask
        // contentMask[r*cols+c] = 1 nếu ô có nội dung (không trắng, không text)
        const contentMask = new Uint8Array(cols * rows);

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cellX = c * gridSize;
                const cellY = r * gridSize;
                const cellW = Math.min(gridSize, W - cellX);
                const cellH = Math.min(gridSize, H - cellY);

                // Bỏ qua ô bị text che
                if (isCoveredByText(cellX, cellY, cellW, cellH, textBoxes)) continue;

                // Kiểm tra nhiều pixel trong ô (không chỉ center)
                let nonWhiteCount = 0;
                const sampleStep = Math.max(1, Math.floor(gridSize / 3));
                for (let dy = 0; dy < cellH; dy += sampleStep) {
                    for (let dx = 0; dx < cellW; dx += sampleStep) {
                        const px = cellX + dx;
                        const py = cellY + dy;
                        if (px >= W || py >= H) continue;
                        const idx = (py * W + px) * 4;
                        const R = pixels[idx], G = pixels[idx + 1], B = pixels[idx + 2], A = pixels[idx + 3];
                        if (A < 10) continue; // transparent → bỏ qua
                        if (!isWhitePixel(R, G, B, whiteThreshold)) {
                            nonWhiteCount++;
                        }
                    }
                }

                // Ô có ít nhất 20% pixel không trắng → đánh dấu là content
                const totalSamples = Math.ceil(cellH / sampleStep) * Math.ceil(cellW / sampleStep);
                if (nonWhiteCount / totalSamples >= 0.2) {
                    contentMask[r * cols + c] = 1;
                }
            }
        }

        // Bước 2: Flood fill để gom các ô liền kề
        const visited = new Uint8Array(cols * rows);
        const regions = [];

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (!contentMask[r * cols + c] || visited[r * cols + c]) continue;

                // BFS
                const queue = [[r, c]];
                visited[r * cols + c] = 1;
                let minR = r, maxR = r, minC = c, maxC = c;
                let cellCount = 0;

                while (queue.length > 0) {
                    const [cr, cc] = queue.shift();
                    cellCount++;
                    if (cr < minR) minR = cr;
                    if (cr > maxR) maxR = cr;
                    if (cc < minC) minC = cc;
                    if (cc > maxC) maxC = cc;

                    // 8-directional neighbors (bắt được đường chéo)
                    for (let dr = -1; dr <= 1; dr++) {
                        for (let dc = -1; dc <= 1; dc++) {
                            if (dr === 0 && dc === 0) continue;
                            const nr = cr + dr, nc = cc + dc;
                            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols
                                && contentMask[nr * cols + nc]
                                && !visited[nr * cols + nc]) {
                                visited[nr * cols + nc] = 1;
                                queue.push([nr, nc]);
                            }
                        }
                    }
                }

                // Tính bounding box thực (pixels)
                const rx = Math.max(0, minC * gridSize - paddingPx);
                const ry = Math.max(0, minR * gridSize - paddingPx);
                const rw = Math.min(W - rx, (maxC - minC + 1) * gridSize + paddingPx * 2);
                const rh = Math.min(H - ry, (maxR - minR + 1) * gridSize + paddingPx * 2);
                const area = cellCount * gridSize * gridSize;

                // Lọc region đủ lớn
                if (area >= minArea && rw >= minWidthPx && rh >= minHeightPx) {
                    regions.push({ x: rx, y: ry, width: rw, height: rh });
                }
            }
        }

        // Bước 3: Merge các region chồng lấp hoặc quá gần nhau
        return mergeOverlappingRegions(regions, paddingPx * 2);
    }

    /**
     * Merge các region chồng lấp hoặc gần nhau
     */
    function mergeOverlappingRegions(regions, gap = 20) {
        if (regions.length === 0) return [];

        let merged = [...regions];
        let changed = true;

        while (changed) {
            changed = false;
            const result = [];
            const used = new Array(merged.length).fill(false);

            for (let i = 0; i < merged.length; i++) {
                if (used[i]) continue;
                let a = merged[i];

                for (let j = i + 1; j < merged.length; j++) {
                    if (used[j]) continue;
                    const b = merged[j];

                    // Kiểm tra overlap hoặc gần nhau (trong khoảng gap)
                    const overlapX = a.x < b.x + b.width + gap && a.x + a.width + gap > b.x;
                    const overlapY = a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

                    if (overlapX && overlapY) {
                        // Merge thành bounding box lớn hơn
                        const nx = Math.min(a.x, b.x);
                        const ny = Math.min(a.y, b.y);
                        const nw = Math.max(a.x + a.width, b.x + b.width) - nx;
                        const nh = Math.max(a.y + a.height, b.y + b.height) - ny;
                        a = { x: nx, y: ny, width: nw, height: nh };
                        used[j] = true;
                        changed = true;
                    }
                }

                result.push(a);
            }
            merged = result;
        }

        return merged;
    }

    /**
     * Crop một vùng từ canvas và trả về PNG Blob
     */
    function cropCanvasRegion(canvas, { x, y, width, height }) {
        return new Promise((resolve) => {
            const offscreen = document.createElement('canvas');
            offscreen.width = Math.max(1, width);
            offscreen.height = Math.max(1, height);
            const ctx = offscreen.getContext('2d');
            ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
            offscreen.toBlob(blob => resolve(blob), 'image/png', 0.95);
        });
    }

    /**
     * Blob → Uint8Array (docx ImageRun cần Uint8Array)
     */
    function blobToUint8Array(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(new Uint8Array(e.target.result));
            reader.onerror = reject;
            reader.readAsArrayBuffer(blob);
        });
    }

    /**
     * PUBLIC: Extract tất cả hình ảnh từ PDF
     * @param {File} file
     * @param {Function} onProgress
     * @returns {Array} images[]
     */
    async function extractImages(file, onProgress = null) {
        initPdfJs();
        const SCALE = 2.5;

        const arrayBuffer = await readFileAsArrayBuffer(file);
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pageCount = pdf.numPages;
        const allImages = [];
        let globalId = 0;

        for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
            if (onProgress) onProgress(
                Math.round((pageNum / pageCount) * 100),
                `Phân tích hình ảnh trang ${pageNum}/${pageCount}...`
            );

            try {
                const page = await pdf.getPage(pageNum);
                const { canvas, viewport } = await renderPageToCanvas(page, SCALE);
                const textContent = await page.getTextContent();
                const textBoxes = getTextBoxes(textContent, viewport);
                const regions = detectImageRegions(canvas, textBoxes);

                for (const region of regions) {
                    const blob = await cropCanvasRegion(canvas, region);
                    if (!blob || blob.size < 800) continue;

                    const uint8 = await blobToUint8Array(blob);
                    globalId++;

                    // Kích thước Word (px): chia scale về kích thước gốc, giới hạn tối đa
                    const wPx = Math.min(Math.round(region.width / SCALE), 500);
                    const hPx = Math.min(Math.round(region.height / SCALE), 650);

                    allImages.push({
                        pageNum,
                        id: globalId,
                        placeholder: `[[IMG:${pageNum}:${globalId}]]`,
                        data: uint8,          // Uint8Array cho docx
                        width: wPx,
                        height: hPx,
                        // vị trí tương đối trên trang (0-1) để inject đúng chỗ
                        relY: region.y / canvas.height
                    });
                }

                console.log(`📄 Trang ${pageNum}: ${regions.length} ảnh`);
            } catch (e) {
                console.warn(`Trang ${pageNum} lỗi:`, e);
            }
        }

        console.log(`✅ Tổng: ${allImages.length} ảnh`);
        return allImages;
    }

    /**
     * Trích xuất text từ PDF dùng PDF.js
     * @param {File} file - File PDF
     * @param {Function} onProgress - Callback tiến trình (0-100)
     * @returns {Object} { text, pageCount, pages[] }
     */
    async function extractText(file, onProgress = null) {
        initPdfJs();

        const arrayBuffer = await readFileAsArrayBuffer(file);
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pageCount = pdf.numPages;
        const pages = [];
        let fullText = '';
        let hasText = false;

        for (let i = 1; i <= pageCount; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();

            // Xây dựng text từ các text items, giữ thứ tự & vị trí
            let pageText = '';
            let lastY = null;

            for (const item of textContent.items) {
                if (item.str === undefined) continue;

                const y = item.transform ? item.transform[5] : null;

                // Xuống dòng mới nếu vị trí y thay đổi đáng kể
                if (lastY !== null && y !== null && Math.abs(lastY - y) > 5) {
                    pageText += '\n';
                } else if (lastY !== null && pageText.length > 0 && !pageText.endsWith('\n')) {
                    // Thêm space giữa các items cùng dòng
                    if (item.str.trim()) {
                        pageText += ' ';
                    }
                }

                pageText += item.str;
                lastY = y;

                if (item.str.trim()) {
                    hasText = true;
                }
            }

            pages.push({
                pageNumber: i,
                text: pageText.trim()
            });

            fullText += (i > 1 ? '\n\n--- Trang ' + i + ' ---\n\n' : '') + pageText.trim();

            if (onProgress) {
                onProgress(Math.round((i / pageCount) * 100));
            }
        }

        return {
            text: fullText,
            pageCount,
            pages,
            hasText,
            method: 'pdf.js'
        };
    }

    /**
     * OCR cho PDF dạng ảnh dùng Tesseract.js
     * @param {File} file - File PDF
     * @param {string} language - Ngôn ngữ OCR (vie, eng, vie+eng)
     * @param {Function} onProgress - Callback tiến trình
     * @returns {Object} { text, pageCount, pages[], confidence }
     */
    async function ocrProcess(file, language = 'vie+eng', onProgress = null) {
        initPdfJs();

        const arrayBuffer = await readFileAsArrayBuffer(file);
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pageCount = pdf.numPages;
        const pages = [];
        let fullText = '';
        let totalConfidence = 0;

        // Tạo Tesseract worker
        if (onProgress) onProgress(5, 'Khởi tạo OCR engine...');

        const worker = await Tesseract.createWorker(language, 1, {
            logger: (m) => {
                if (m.status === 'recognizing text' && onProgress) {
                    // Không cập nhật ở đây, để chính xác hơn theo page
                }
            }
        });

        for (let i = 1; i <= pageCount; i++) {
            if (onProgress) {
                const pct = Math.round(10 + (i / pageCount) * 85);
                onProgress(pct, `OCR đang xử lý trang ${i}/${pageCount}...`);
            }

            // Render page thành canvas
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2.0 }); // Scale cao để OCR chính xác
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({ canvasContext: ctx, viewport }).promise;

            // OCR canvas
            const { data } = await worker.recognize(canvas);

            pages.push({
                pageNumber: i,
                text: data.text.trim(),
                confidence: data.confidence
            });

            fullText += (i > 1 ? '\n\n--- Trang ' + i + ' ---\n\n' : '') + data.text.trim();
            totalConfidence += data.confidence;
        }

        await worker.terminate();

        if (onProgress) onProgress(100, 'Hoàn tất OCR!');

        return {
            text: fullText,
            pageCount,
            pages,
            hasText: fullText.trim().length > 0,
            confidence: Math.round(totalConfidence / pageCount),
            method: 'tesseract.js'
        };
    }

    /**
     * Tự động nhận dạng và xử lý PDF
     * Thử text extraction trước, nếu không có text thì dùng OCR
     * @param {File} file
     * @param {Object} options - { language, forceOcr }
     * @param {Function} onProgress
     * @returns {Object} result
     */
    async function autoProcess(file, options = {}, onProgress = null) {
        const startTime = Date.now();

        if (options.forceOcr) {
            if (onProgress) onProgress(5, 'Bắt đầu OCR...');
            const result = await ocrProcess(file, options.language || 'vie+eng', onProgress);
            result.processingTime = Date.now() - startTime;
            return result;
        }

        // Thử text extraction trước
        if (onProgress) onProgress(10, 'Đang trích xuất text...');
        const textResult = await extractText(file, (pct) => {
            if (onProgress) onProgress(10 + Math.round(pct * 0.4), 'Đang trích xuất text...');
        });

        // Kiểm tra xem có text hay không
        const textLength = textResult.text.replace(/\s/g, '').length;
        const hasEnoughText = textLength > (textResult.pageCount * 20); // Ít nhất 20 ký tự/trang

        if (hasEnoughText) {
            textResult.processingTime = Date.now() - startTime;
            textResult.confidence = 99;
            if (onProgress) onProgress(100, 'Trích xuất hoàn tất!');
            return textResult;
        }

        // Không có text → dùng OCR
        if (onProgress) onProgress(50, 'PDF dạng ảnh, chuyển sang OCR...');
        const ocrResult = await ocrProcess(file, options.language || 'vie+eng', (pct, msg) => {
            if (onProgress) onProgress(50 + Math.round(pct * 0.5), msg);
        });

        ocrResult.processingTime = Date.now() - startTime;
        return ocrResult;
    }

    /**
     * Xử lý batch nhiều file
     * @param {FileList|Array} files
     * @param {Object} options
     * @param {Function} onProgress - (fileIndex, totalFiles, filePct, msg)
     * @returns {Array} results
     */
    async function processBatch(files, options = {}, onProgress = null) {
        const results = [];
        const fileArray = Array.from(files);

        for (let i = 0; i < fileArray.length; i++) {
            const file = fileArray[i];

            try {
                const result = await autoProcess(file, options, (pct, msg) => {
                    if (onProgress) {
                        onProgress(i, fileArray.length, pct, `[${i + 1}/${fileArray.length}] ${file.name}: ${msg || ''}`);
                    }
                });

                result.fileName = file.name;
                result.fileSize = file.size;
                results.push(result);
            } catch (error) {
                results.push({
                    fileName: file.name,
                    fileSize: file.size,
                    success: false,
                    error: error.message,
                    text: '',
                    pageCount: 0
                });
            }
        }

        return results;
    }

    /**
     * Format file size
     */
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    return {
        extractText,
        ocrProcess,
        autoProcess,
        processBatch,
        extractImages,
        formatFileSize
    };
})();
