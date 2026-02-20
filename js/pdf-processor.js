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
        formatFileSize
    };
})();
