/**
 * ========================================
 * Gemini AI Service Module
 * Xử lý công thức toán học bằng Gemini API
 * Model fallback & API key management
 * ========================================
 */

const GeminiService = (() => {
    // ========================================
    // CONFIGURATION
    // ========================================
    const MODELS = [
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Nhanh, tiết kiệm quota', badge: 'Default' },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Chính xác hơn, tốn quota', badge: 'Pro' },
        { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', desc: 'Dự phòng, ổn định', badge: 'Backup' }
    ];

    const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
    const STORAGE_KEY_API = 'gemini_api_key';
    const STORAGE_KEY_MODEL = 'gemini_model';

    // ========================================
    // API KEY MANAGEMENT
    // ========================================
    function getApiKey() {
        return localStorage.getItem(STORAGE_KEY_API) || '';
    }

    function setApiKey(key) {
        localStorage.setItem(STORAGE_KEY_API, key.trim());
    }

    function hasApiKey() {
        return !!getApiKey();
    }

    function clearApiKey() {
        localStorage.removeItem(STORAGE_KEY_API);
    }

    // ========================================
    // MODEL MANAGEMENT
    // ========================================
    function getSelectedModel() {
        return localStorage.getItem(STORAGE_KEY_MODEL) || MODELS[0].id;
    }

    function setSelectedModel(modelId) {
        localStorage.setItem(STORAGE_KEY_MODEL, modelId);
    }

    function getModelList() {
        return MODELS;
    }

    // ========================================
    // API CALL WITH FALLBACK
    // ========================================

    /**
     * Gọi Gemini API với auto-retry & model fallback
     * @param {string} prompt - Prompt gửi tới Gemini
     * @param {Object} options - { temperature, maxTokens }
     * @returns {string} Response text
     */
    async function callGemini(prompt, options = {}) {
        const apiKey = getApiKey();
        if (!apiKey) {
            throw new Error('API_KEY_MISSING');
        }

        const { temperature = 0.1, maxTokens = 65536 } = options;

        // Build model fallback order: selected model first, then others
        const selectedModel = getSelectedModel();
        const modelOrder = [selectedModel, ...MODELS.map(m => m.id).filter(id => id !== selectedModel)];

        let lastError = null;

        for (const modelId of modelOrder) {
            try {
                console.log(`🤖 Trying model: ${modelId}`);
                const result = await makeApiRequest(modelId, apiKey, prompt, temperature, maxTokens);
                console.log(`✅ Success with model: ${modelId}`);
                return result;
            } catch (error) {
                console.warn(`⚠️ Model ${modelId} failed:`, error.message);
                lastError = error;

                // Don't retry on auth errors
                if (error.message.includes('API_KEY_INVALID') || error.message.includes('401')) {
                    throw error;
                }

                // Continue to next model for rate limit / overload errors
                continue;
            }
        }

        throw lastError || new Error('Tất cả model đều thất bại');
    }

    /**
     * Make single API request to Gemini
     */
    async function makeApiRequest(modelId, apiKey, prompt, temperature, maxTokens) {
        const url = `${API_BASE}/${modelId}:generateContent?key=${apiKey}`;

        const body = {
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature,
                maxOutputTokens: maxTokens,
                topP: 0.95
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;

            if (response.status === 401 || response.status === 403) {
                throw new Error('API_KEY_INVALID: ' + errorMsg);
            }
            if (response.status === 429) {
                throw new Error('RATE_LIMITED: ' + errorMsg);
            }
            throw new Error(`API_ERROR (${response.status}): ${errorMsg}`);
        }

        const data = await response.json();

        // Extract text from response
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            throw new Error('Không nhận được response text từ Gemini');
        }

        return text;
    }

    // ========================================
    // MATH FORMULA PROCESSING
    // ========================================

    /**
     * Xử lý text từ PDF — nhận dạng & sửa công thức toán sang LaTeX
     * @param {string} rawText - Text thô từ PDF extraction
     * @param {Function} onProgress - Progress callback
     * @returns {string} Text đã xử lý với LaTeX formulas
     */
    async function processMathFormulas(rawText, onProgress = null) {
        if (!rawText || rawText.trim().length === 0) {
            return rawText;
        }

        if (onProgress) onProgress(10, 'Đang chuẩn bị dữ liệu gửi tới Gemini AI...');

        // Tăng giới hạn chunk (từ 4000 lên 15000 ký tự) để giảm số lần gọi API (Gemini xử lý được ngữ cảnh dài)
        const MAX_CHUNK = 15000;
        const chunks = splitIntoChunks(rawText, MAX_CHUNK);
        let processedTexts = new Array(chunks.length);

        let completedChunks = 0;

        // Xử lý song song với concurrency = 3 để chạy nhanh gấp 3 lần nhưng không bị dính giới hạn (Rate Limit) của gói API Free (15 RPM)
        const CONCURRENCY = 3;

        for (let i = 0; i < chunks.length; i += CONCURRENCY) {
            const batch = chunks.slice(i, i + CONCURRENCY);

            const promises = batch.map(async (chunk, batchIndex) => {
                const globalIndex = i + batchIndex;
                const prompt = buildMathPrompt(chunk);
                const result = await callGemini(prompt, { temperature: 0.1 });

                // Clean response (remove markdown code blocks if Gemini wraps them)
                const cleaned = cleanGeminiResponse(result);
                processedTexts[globalIndex] = cleaned;

                completedChunks++;
                if (onProgress) {
                    const pct = 10 + Math.round((completedChunks / chunks.length) * 80);
                    onProgress(pct, `Gemini AI đã xử lý xong phần ${completedChunks}/${chunks.length}...`);
                }
            });

            // Chờ batch xử lý xong trước khi chuyển sang batch tiếp theo để không chặn luồng API
            await Promise.all(promises);
        }

        if (onProgress) onProgress(95, 'Hoàn tất xử lý công thức toán!');

        return processedTexts.join('\n\n');
    }

    /**
     * Build prompt for math formula recognition
     */
    function buildMathPrompt(text) {
        return `Bạn là chuyên gia xử lý văn bản OCR đề thi Toán Việt Nam. Sửa lỗi chính tả và chuẩn hóa LaTeX cho văn bản OCR sau.

QUY TẮC:
1. Sửa lỗi chính tả tiếng Việt (giữ nguyên ý nghĩa)
2. Nhận dạng và chuyển TẤT CẢ công thức toán sang LaTeX chuẩn:
   - Công thức inline: $...$ (ví dụ: $y = -4x - 5$)
   - Công thức display: $$...$$ cho công thức dài/quan trọng
3. Chuẩn hóa ký hiệu LaTeX:
   - Góc: dùng \\widehat{ABC} thay vì ∠ABC
   - Hệ phương trình: dùng \\begin{cases}...\\end{cases}
   - Phân số: dùng \\frac{tử}{mẫu}
   - Căn: dùng \\sqrt{} hoặc \\sqrt[n]{}
   - Tập hợp: dùng \\mathbb{R}, \\mathbb{N}, v.v.
   - Giới hạn: \\lim_{x \\to a}
   - Tích phân: \\int_{a}^{b}
4. Lỗi OCR thường gặp cần sửa:
   - "—", "–" → dấu trừ "$-$"
   - "V" hoặc "v" + số → $\\sqrt{}$
   - "Ñ", ký tự lạ trong ngữ cảnh toán → ký hiệu tập hợp phù hợp
   - "x^" thiếu mũ → bổ sung (thường là $x^2$)
   - "D=" → tập xác định, format: $D = ...$
   - Các đáp án A. B. C. D. giữ nguyên cấu trúc trắc nghiệm
5. Giữ format Markdown (## heading, **bold**, danh sách)
6. CHỈ trả về text đã sửa. KHÔNG giải thích.
7. GIỮ NGUYÊN 100% các placeholder hình ảnh có dạng [[IMG:số:số]] — KHÔNG xóa, KHÔNG sửa, KHÔNG di chuyển chúng.
8. GIỮ NGUYÊN 100% các HTML comment có dạng <!--...--> — KHÔNG xóa, KHÔNG sửa chúng.

VĂN BẢN:
${text}`;
    }

    /**
     * Clean Gemini response
     */
    function cleanGeminiResponse(response) {
        let cleaned = response.trim();

        // Remove markdown code block wrappers
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
        }

        return cleaned.trim();
    }

    /**
     * Split text into chunks at natural boundaries
     */
    function splitIntoChunks(text, maxLength) {
        if (text.length <= maxLength) return [text];

        const chunks = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }

            // Find a good split point (double newline, page break, or sentence end)
            let splitAt = maxLength;
            const searchArea = remaining.substring(Math.max(0, maxLength - 500), maxLength);

            // Try page separator first
            const pageSep = searchArea.lastIndexOf('--- Trang');
            if (pageSep !== -1) {
                splitAt = Math.max(0, maxLength - 500) + pageSep;
            } else {
                // Try double newline
                const doubleNl = searchArea.lastIndexOf('\n\n');
                if (doubleNl !== -1) {
                    splitAt = Math.max(0, maxLength - 500) + doubleNl;
                } else {
                    // Try single newline
                    const singleNl = searchArea.lastIndexOf('\n');
                    if (singleNl !== -1) {
                        splitAt = Math.max(0, maxLength - 500) + singleNl;
                    }
                }
            }

            chunks.push(remaining.substring(0, splitAt));
            remaining = remaining.substring(splitAt).trimStart();
        }

        return chunks;
    }

    // ========================================
    // VALIDATE API KEY
    // ========================================

    /**
     * Test if API key is valid
     */
    async function validateApiKey(key) {
        try {
            const url = `${API_BASE}/${MODELS[0].id}:generateContent?key=${key}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: 'Trả lời "OK"' }] }],
                    generationConfig: { maxOutputTokens: 10 }
                })
            });

            if (response.status === 401 || response.status === 403) {
                return { valid: false, error: 'API key không hợp lệ' };
            }

            if (response.ok) {
                return { valid: true };
            }

            return { valid: false, error: `Lỗi: HTTP ${response.status}` };
        } catch (error) {
            return { valid: false, error: 'Không thể kết nối: ' + error.message };
        }
    }

    // ========================================
    // PUBLIC API
    // ========================================
    return {
        // API Key
        getApiKey,
        setApiKey,
        hasApiKey,
        clearApiKey,
        validateApiKey,

        // Model
        getSelectedModel,
        setSelectedModel,
        getModelList,

        // AI Processing
        callGemini,
        processMathFormulas,

        // Constants
        MODELS
    };
})();
