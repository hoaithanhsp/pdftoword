/**
 * ========================================
 * App.js - Main Application Logic
 * Điều phối UI, upload, xử lý, Gemini AI, KaTeX render
 * ========================================
 */

(() => {
    // ========================================
    // STATE
    // ========================================
    let selectedFiles = [];
    let isProcessing = false;
    let lastResults = null;
    let lastProcessedText = ''; // Text after AI processing
    let lastRawText = '';       // Raw text before AI
    let extractedImages = [];   // Array of page images extracted from PDF

    // ========================================
    // DOM HELPERS
    // ========================================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ========================================
    // INITIALIZATION
    // ========================================
    document.addEventListener('DOMContentLoaded', () => {
        setupUploadZone();
        setupButtons();
        setupModal();
        setupViewToggle();
        checkApiKeyStatus();
        console.log('🚀 PDF to Word Converter v2.0 initialized');
    });

    // ========================================
    // API KEY MODAL
    // ========================================
    function setupModal() {
        const modal = $('#apiKeyModal');
        const input = $('#apiKeyInput');
        const saveBtn = $('#saveApiKeyBtn');
        const skipBtn = $('#skipApiKeyBtn');
        const toggleBtn = $('#toggleKeyVisibility');
        const openSettings = $('#openSettingsBtn');
        const openModalLink = $('#openModalLink');

        // Render model cards
        renderModelCards();

        // Load existing key
        const existingKey = GeminiService.getApiKey();
        if (existingKey) {
            input.value = existingKey;
            modal.classList.add('hidden');
        }

        // Toggle password visibility
        toggleBtn?.addEventListener('click', () => {
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            toggleBtn.innerHTML = `<i class="fas fa-eye${isPassword ? '-slash' : ''}"></i>`;
        });

        // Save API key
        saveBtn?.addEventListener('click', async () => {
            const key = input.value.trim();
            if (!key) {
                showValidationStatus('Vui lòng nhập API key!', 'error');
                return;
            }

            showValidationStatus('Đang kiểm tra key...', 'loading');
            const result = await GeminiService.validateApiKey(key);

            if (result.valid) {
                GeminiService.setApiKey(key);
                showValidationStatus('✅ API key hợp lệ!', 'success');
                setTimeout(() => {
                    modal.classList.add('hidden');
                    checkApiKeyStatus();
                    showToast('API key đã được lưu!', 'success');
                }, 800);
            } else {
                showValidationStatus('❌ ' + result.error, 'error');
            }
        });

        // Skip button
        skipBtn?.addEventListener('click', () => {
            modal.classList.add('hidden');
            checkApiKeyStatus();
        });

        // Open settings from header
        openSettings?.addEventListener('click', () => {
            const existKey = GeminiService.getApiKey();
            if (existKey) input.value = existKey;
            modal.classList.remove('hidden');
        });

        // Open modal from warning link
        openModalLink?.addEventListener('click', (e) => {
            e.preventDefault();
            const existKey = GeminiService.getApiKey();
            if (existKey) input.value = existKey;
            modal.classList.remove('hidden');
        });
    }

    function renderModelCards() {
        const container = $('#modelCards');
        if (!container) return;

        const models = GeminiService.getModelList();
        const selected = GeminiService.getSelectedModel();

        container.innerHTML = models.map(m => `
            <div class="model-card ${m.id === selected ? 'active' : ''}" data-model="${m.id}">
                <div class="model-radio"></div>
                <div class="model-info">
                    <div class="model-name">${m.name}</div>
                    <div class="model-desc">${m.desc}</div>
                </div>
                <span class="model-badge">${m.badge}</span>
            </div>
        `).join('');

        // Click handlers
        container.querySelectorAll('.model-card').forEach(card => {
            card.addEventListener('click', () => {
                container.querySelectorAll('.model-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                GeminiService.setSelectedModel(card.dataset.model);
            });
        });
    }

    function showValidationStatus(message, type) {
        const el = $('#validationStatus');
        if (!el) return;

        el.classList.remove('hidden', 'success', 'error');

        const icons = {
            loading: '<i class="fas fa-spinner fa-spin"></i>',
            success: '<i class="fas fa-check-circle"></i>',
            error: '<i class="fas fa-times-circle"></i>'
        };

        el.className = `validation-status ${type}`;
        el.innerHTML = `${icons[type] || ''} <span>${message}</span>`;
    }

    function checkApiKeyStatus() {
        const hasKey = GeminiService.hasApiKey();
        const warning = $('#apiWarning');
        const label = $('#settingsLabel');

        if (warning) {
            if (hasKey) {
                warning.classList.add('hidden');
            } else {
                warning.classList.remove('hidden');
            }
        }

        if (label) {
            label.textContent = hasKey ? 'Cài đặt' : 'Nhập API Key';
        }
    }

    // ========================================
    // VIEW TOGGLE (Rendered / Raw)
    // ========================================
    function setupViewToggle() {
        const renderedBtn = $('#viewRenderedBtn');
        const rawBtn = $('#viewRawBtn');

        renderedBtn?.addEventListener('click', () => {
            renderedBtn.classList.add('active');
            rawBtn.classList.remove('active');
            $('#resultsRendered').style.display = 'block';
            $('#resultsText').style.display = 'none';
        });

        rawBtn?.addEventListener('click', () => {
            rawBtn.classList.add('active');
            renderedBtn.classList.remove('active');
            $('#resultsRendered').style.display = 'none';
            $('#resultsText').style.display = 'block';
        });
    }

    // ========================================
    // UPLOAD ZONE
    // ========================================
    function setupUploadZone() {
        const zone = $('#uploadZone');
        const input = $('#fileInput');

        zone.addEventListener('click', (e) => {
            if (isProcessing) return;
            e.preventDefault();
            input.click();
        });

        input.addEventListener('change', (e) => {
            if (isProcessing || !e.target.files.length) return;
            const batchMode = $('#batchToggle') && $('#batchToggle').checked;
            if (batchMode) {
                addFiles(Array.from(e.target.files));
            } else {
                selectedFiles = [e.target.files[0]];
                renderFilePreview();
            }
            input.value = '';
        });

        zone.addEventListener('dragenter', (e) => { e.preventDefault(); if (!isProcessing) zone.classList.add('dragover'); });
        zone.addEventListener('dragover', (e) => { e.preventDefault(); if (!isProcessing) zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', (e) => { e.preventDefault(); zone.classList.remove('dragover'); });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (isProcessing) return;
            const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
            if (files.length === 0) { showToast('Vui lòng chọn file PDF!', 'error'); return; }
            const batchMode = $('#batchToggle') && $('#batchToggle').checked;
            if (batchMode) { addFiles(files); } else { selectedFiles = [files[0]]; renderFilePreview(); }
        });
    }

    function addFiles(newFiles) {
        const pdfs = newFiles.filter(f => f.type === 'application/pdf');
        if (pdfs.length === 0) { showToast('Chỉ hỗ trợ file PDF!', 'error'); return; }
        selectedFiles = [...selectedFiles, ...pdfs];
        renderFilePreview();
    }

    function removeFile(index) {
        selectedFiles.splice(index, 1);
        renderFilePreview();
    }
    window.removeFile = removeFile;

    function renderFilePreview() {
        const container = $('#filePreviewContainer');
        container.innerHTML = '';
        if (selectedFiles.length === 0) { updateProcessButton(); return; }

        if (selectedFiles.length === 1) {
            const file = selectedFiles[0];
            container.innerHTML = `
                <div class="file-preview">
                    <div class="file-icon"><i class="fas fa-file-pdf"></i></div>
                    <div class="file-info">
                        <div class="file-name">${file.name}</div>
                        <div class="file-size">${PdfProcessor.formatFileSize(file.size)}</div>
                    </div>
                    <button class="file-remove" onclick="removeFile(0)" title="Xóa"><i class="fas fa-times"></i></button>
                </div>`;
        } else {
            let html = '<div class="batch-file-list">';
            selectedFiles.forEach((file, i) => {
                html += `<div class="batch-file-item">
                    <div class="file-icon"><i class="fas fa-file-pdf"></i></div>
                    <div class="file-name">${file.name}</div>
                    <div class="file-size">${PdfProcessor.formatFileSize(file.size)}</div>
                    <button class="file-remove" onclick="removeFile(${i})" title="Xóa"><i class="fas fa-times"></i></button>
                </div>`;
            });
            html += '</div>';
            container.innerHTML = html;
        }
        updateProcessButton();
    }

    function updateProcessButton() {
        const btn = $('#processBtn');
        if (!btn) return;
        if (selectedFiles.length > 0) {
            btn.disabled = false;
            btn.innerHTML = selectedFiles.length > 1
                ? `<i class="fas fa-magic"></i> Xử lý ${selectedFiles.length} file PDF`
                : `<i class="fas fa-magic"></i> Bắt đầu chuyển đổi`;
        } else {
            btn.disabled = true;
            btn.innerHTML = `<i class="fas fa-magic"></i> Chọn file PDF trước`;
        }
    }

    // ========================================
    // BUTTONS SETUP
    // ========================================
    function setupButtons() {
        $('#processBtn')?.addEventListener('click', startProcessing);

        $('#copyBtn')?.addEventListener('click', async () => {
            if (!lastProcessedText && !lastRawText) return;
            const text = lastProcessedText || lastRawText;
            const ok = await WordExporter.copyToClipboard(text);
            showToast(ok ? 'Đã sao chép!' : 'Không thể sao chép!', ok ? 'success' : 'error');
        });

        $('#downloadTxtBtn')?.addEventListener('click', () => {
            if (!lastProcessedText && !lastRawText) return;
            const text = lastProcessedText || lastRawText;
            WordExporter.downloadAsTxt(text, getFileName());
            showToast('Đã tải file TXT!', 'success');
        });

        $('#exportWordBtn')?.addEventListener('click', async () => {
            if (!lastProcessedText && !lastRawText) return;
            try {
                showToast('Đang tạo file Word...', 'info');
                const text = lastProcessedText || lastRawText;
                console.log('📋 Export Word — extractedImages:', extractedImages.length,
                    'text contains [[IMG:', text.includes('[[IMG:'));
                let result;

                if (extractedImages.length > 0) {
                    // Dùng export có ảnh
                    result = await WordExporter.exportToWordWithImages(
                        text,
                        extractedImages,
                        getFileName(),
                        { fontSize: 24, fontName: 'Times New Roman' }
                    );
                } else {
                    // Không có ảnh → export thường
                    result = await WordExporter.exportToWord(
                        text,
                        getFileName(),
                        { fontSize: 24, fontName: 'Times New Roman' }
                    );
                }

                if (result.success) showToast(`✅ Đã tải ${result.fileName}!`, 'success');
            } catch (err) {
                console.error('Word export error:', err);
                showToast('❌ Lỗi tạo Word: ' + err.message, 'error');
            }
        });
    }

    function getFileName() {
        if (selectedFiles.length > 0) {
            return selectedFiles[0].name.replace(/\.[^/.]+$/, '') + '_converted';
        }
        return 'converted';
    }

    // ========================================
    // PROCESSING
    // ========================================
    async function startProcessing() {
        if (isProcessing || selectedFiles.length === 0) return;

        isProcessing = true;
        extractedImages = [];
        const btn = $('#processBtn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang xử lý...';

        const language = $('#languageSelect')?.value || 'vie+eng';
        const forceOcr = $('#ocrToggle')?.checked || false;
        const useAiMath = $('#aiMathToggle')?.checked || false;
        const keepImages = $('#keepImagesToggle')?.checked ?? true;
        const options = { language, forceOcr };

        const progressContainer = $('#progressContainer');
        progressContainer.classList.add('active');
        updateProgress(0, 'Bắt đầu xử lý...');

        $('#resultsSection').classList.remove('active');
        $('#statsGrid').classList.remove('active');
        $('#alertContainer').innerHTML = '';

        const globalStartTime = Date.now();

        try {
            let rawText = '';
            let result;

            // ── Phase 1: Extract text (0→40%) ─────────────────
            if (selectedFiles.length === 1) {
                result = await PdfProcessor.autoProcess(selectedFiles[0], options, (pct, msg) => {
                    updateProgress(Math.round(pct * 0.4), msg || 'Đang trích xuất text...');
                });
                lastResults = result;
                rawText = result.text || '';
            } else {
                const results = await PdfProcessor.processBatch(selectedFiles, options, (fi, total, pct, msg) => {
                    const overall = Math.round(((fi + pct / 100) / total) * 100);
                    updateProgress(Math.round(overall * 0.4), msg || `File ${fi + 1}/${total}...`);
                });
                lastResults = results;
                rawText = results.map(r => r.text || '').join('\n\n====\n\n');
            }

            lastRawText = rawText;

            // ── Phase 2: Extract images (41→55%) ──────────────
            if (keepImages && selectedFiles.length === 1) {
                updateProgress(41, '🖼️ Đang phát hiện hình ảnh...');
                try {
                    extractedImages = await PdfProcessor.extractImages(
                        selectedFiles[0],
                        (pct, msg) => updateProgress(41 + Math.round(pct * 0.14), msg)
                    );

                    if (extractedImages.length > 0) {
                        console.log('📸 Images extracted:', extractedImages.length,
                            'Sample:', extractedImages[0].placeholder,
                            'data size:', extractedImages[0].data?.byteLength || 0,
                            'width:', extractedImages[0].width, 'height:', extractedImages[0].height);
                        rawText = injectImagePlaceholders(rawText, extractedImages);
                        console.log('📝 After inject — text sample:', rawText.substring(0, 500));
                        lastRawText = rawText;
                        showAlert(`🖼️ Phát hiện ${extractedImages.length} hình ảnh — sẽ nhúng vào Word`, 'info');
                    } else {
                        showAlert('ℹ️ Không phát hiện hình ảnh trong PDF', 'info');
                    }
                } catch (imgErr) {
                    console.warn('Image extraction failed:', imgErr);
                    showAlert('⚠️ Lỗi trích xuất ảnh: ' + imgErr.message, 'warning');
                }
            }

            // ── Phase 3: AI Math (56→98%) ────────────────────
            if (useAiMath && GeminiService.hasApiKey() && rawText.trim().length > 0) {
                updateProgress(56, '🤖 Gemini AI đang xử lý công thức toán...');
                try {
                    lastProcessedText = await GeminiService.processMathFormulas(rawText, (pct, msg) => {
                        updateProgress(56 + Math.round(pct * 0.42), msg);
                    });
                } catch (aiError) {
                    console.error('AI error:', aiError);
                    lastProcessedText = rawText;
                    if (aiError.message.includes('API_KEY_MISSING')) {
                        showAlert('⚠️ Chưa có API key! Hiển thị text gốc.', 'warning');
                    } else if (aiError.message.includes('API_KEY_INVALID')) {
                        showAlert('❌ API key không hợp lệ!', 'error');
                    } else {
                        showAlert('⚠️ Gemini AI lỗi: ' + aiError.message, 'warning');
                    }
                }
            } else {
                lastProcessedText = rawText;
            }

            updateProgress(99, 'Hoàn tất!');

            const totalMs = Date.now() - globalStartTime;
            if (Array.isArray(lastResults)) {
                lastResults.forEach(r => r.processingTime = totalMs / lastResults.length);
            } else if (lastResults) {
                lastResults.processingTime = totalMs;
            }

            if (Array.isArray(lastResults)) {
                displayBatchResults(lastResults);
            } else {
                displaySingleResult(lastResults);
            }

            if (useAiMath && lastProcessedText !== lastRawText) {
                renderLatex(lastProcessedText);
            }

        } catch (error) {
            console.error('Processing error:', error);
            showAlert('❌ Lỗi xử lý: ' + error.message, 'error');
        } finally {
            isProcessing = false;
            btn.disabled = false;
            updateProcessButton();
            progressContainer.classList.remove('active');
        }
    }

    // Helper: Inject image placeholders vào đúng vị trí trong text
    function injectImagePlaceholders(text, images) {
        if (!images || images.length === 0) return text;

        // Group images by page
        const byPage = {};
        for (const img of images) {
            if (!byPage[img.pageNum]) byPage[img.pageNum] = [];
            byPage[img.pageNum].push(img);
        }

        const pageTexts = text.split(/(\n\n---\s*Trang\s*\d+\s*---\n\n)/i);
        // pageTexts[0] = trang 1, sau đó xen kẽ separator + nội dung

        // Rebuild với placeholders chèn vào đầu mỗi trang
        let result = '';
        let currentPage = 1;

        for (let i = 0; i < pageTexts.length; i++) {
            const chunk = pageTexts[i];
            const sepMatch = chunk.match(/---\s*Trang\s*(\d+)\s*---/i);

            if (sepMatch) {
                currentPage = parseInt(sepMatch[1]);
                result += chunk;
            } else {
                // Chèn placeholders của trang currentPage vào đầu chunk này
                const imgs = byPage[currentPage];
                if (imgs && imgs.length > 0) {
                    // Sort theo vị trí tương đối (relY) để chèn đúng thứ tự
                    const placeholders = imgs
                        .sort((a, b) => a.relY - b.relY)
                        .map(img => img.placeholder)
                        .join('\n');
                    result += placeholders + '\n\n' + chunk;
                } else {
                    result += chunk;
                }
            }
        }

        return result;
    }

    // ========================================
    // DISPLAY RESULTS
    // ========================================
    function displaySingleResult(result) {
        const processingTime = Math.round((result.processingTime || 0) / 1000);

        $('#pageCount').textContent = result.pageCount || 0;
        $('#confidence').textContent = (result.confidence || 0) + '%';
        $('#processingTime').textContent = processingTime + 's';
        $('#statsGrid').classList.add('active');

        // Raw text
        $('#resultsText').textContent = lastProcessedText || result.text || 'Không có văn bản';

        // Show results
        $('#resultsSection').classList.add('active');

        const methodLabel = result.method === 'tesseract.js' ? 'OCR (Tesseract.js)' : 'PDF.js';
        const aiLabel = (lastProcessedText !== lastRawText) ? ' + Gemini AI' : '';
        showAlert(`✅ Xử lý thành công bằng ${methodLabel}${aiLabel}! ${result.pageCount} trang trong ${processingTime}s`, 'success');
    }

    function displayBatchResults(results) {
        const successful = results.filter(r => r.text && r.text.trim());
        const totalPages = results.reduce((sum, r) => sum + (r.pageCount || 0), 0);
        const totalTime = Math.round(results.reduce((sum, r) => sum + (r.processingTime || 0), 0) / 1000);

        $('#pageCount').textContent = totalPages;
        $('#confidence').textContent = '-';
        $('#processingTime').textContent = totalTime + 's';
        $('#statsGrid').classList.add('active');

        $('#resultsText').textContent = lastProcessedText || 'Không có văn bản';
        $('#resultsSection').classList.add('active');

        showAlert(`✅ Đã xử lý ${successful.length}/${results.length} file, tổng ${totalPages} trang trong ${totalTime}s`, 'success');
    }

    // ========================================
    // LATEX RENDERING
    // ========================================
    function renderLatex(text) {
        const container = $('#resultsRendered');
        const toggle = $('#viewToggle');
        if (!container || !toggle) return;

        // Convert text to HTML paragraphs
        const lines = text.split('\n');
        let html = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                html += '<br>';
            } else {
                // Escape HTML but keep $ for KaTeX
                const escaped = trimmed
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                html += `<p>${escaped}</p>`;
            }
        }

        container.innerHTML = html;
        container.style.display = 'block';
        $('#resultsText').style.display = 'none';
        toggle.style.display = 'flex';

        // Set rendered view as active
        $('#viewRenderedBtn')?.classList.add('active');
        $('#viewRawBtn')?.classList.remove('active');

        // Auto-render KaTeX
        if (typeof renderMathInElement === 'function') {
            try {
                renderMathInElement(container, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false },
                        { left: '\\[', right: '\\]', display: true },
                        { left: '\\(', right: '\\)', display: false }
                    ],
                    throwOnError: false,
                    errorColor: '#dc2626'
                });
                console.log('✅ KaTeX rendering complete');
            } catch (err) {
                console.warn('KaTeX rendering error:', err);
            }
        }
    }

    // ========================================
    // PROGRESS
    // ========================================
    function updateProgress(percent, statusText) {
        const fill = $('#progressFill');
        const pctEl = $('#progressPercent');
        const statusEl = $('#progressStatus');
        if (fill) fill.style.width = percent + '%';
        if (pctEl) pctEl.textContent = percent + '%';
        if (statusEl) statusEl.textContent = statusText || '';
    }

    // ========================================
    // ALERTS & TOASTS
    // ========================================
    function showAlert(message, type = 'info') {
        const container = $('#alertContainer');
        const icons = { success: 'fa-check-circle', error: 'fa-exclamation-triangle', warning: 'fa-exclamation-circle', info: 'fa-info-circle' };
        const div = document.createElement('div');
        div.className = `alert alert-${type}`;
        div.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;
        container.appendChild(div);
        setTimeout(() => { div.style.opacity = '0'; div.style.transform = 'translateY(-10px)'; setTimeout(() => div.remove(), 300); }, 8000);
    }

    function showToast(message, type = 'info') {
        let container = $('#toastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toastContainer';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        const icons = { success: 'fa-check-circle', error: 'fa-exclamation-triangle', info: 'fa-info-circle' };
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;
        container.appendChild(toast);
        setTimeout(() => { toast.classList.add('removing'); setTimeout(() => toast.remove(), 300); }, 3500);
    }

    window.showToast = showToast;

})();
