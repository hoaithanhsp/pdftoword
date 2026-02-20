/**
 * ========================================
 * Word Exporter Module v2.0
 * Port from smart-pdf-ocr wordExportService.ts
 * Supports real Word Math objects (OXML)
 * ========================================
 */

const WordExporter = (() => {

    // ========================================
    // LATEX SYMBOL MAPPING
    // ========================================
    const latexSymbols = {
        "\\Delta": "Δ", "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ", "\\epsilon": "ε", "\\varepsilon": "ε",
        "\\zeta": "ζ", "\\eta": "η", "\\pi": "π", "\\Pi": "Π", "\\infty": "∞", "\\theta": "θ", "\\Theta": "Θ",
        "\\lambda": "λ", "\\Lambda": "Λ", "\\sigma": "σ", "\\Sigma": "Σ", "\\Omega": "Ω", "\\omega": "ω",
        "\\mu": "μ", "\\phi": "φ", "\\varphi": "φ", "\\Phi": "Φ", "\\psi": "ψ", "\\Psi": "Ψ", "\\rho": "ρ", "\\tau": "τ",
        "\\le": "≤", "\\leq": "≤", "\\ge": "≥", "\\geq": "≥", "\\ne": "≠", "\\neq": "≠",
        "\\approx": "≈", "\\pm": "±", "\\mp": "∓", "\\equiv": "≡",
        "\\times": "×", "\\cdot": "·", "\\div": "÷", "\\ast": "*",
        "\\rightarrow": "→", "\\Rightarrow": "⇒", "\\Leftrightarrow": "⇔", "\\leftrightarrow": "↔",
        "\\in": "∈", "\\subset": "⊂", "\\subseteq": "⊆", "\\cup": "∪", "\\cap": "∩", "\\notin": "∉", "\\emptyset": "∅",
        "\\forall": "∀", "\\exists": "∃", "\\partial": "∂", "\\nabla": "∇",
        "\\perp": "⊥", "\\parallel": "∥", "\\angle": "∠", "\\triangle": "△",
        "\\degrees": "°", "\\circ": "°", "\\deg": "°",
        "\\mathbb{N}": "ℕ", "\\mathbb{Z}": "ℤ", "\\mathbb{Q}": "ℚ", "\\mathbb{R}": "ℝ", "\\mathbb{C}": "ℂ",
        "\\sin": "sin", "\\cos": "cos", "\\tan": "tan", "\\cot": "cot",
        "\\arcsin": "arcsin", "\\arccos": "arccos", "\\arctan": "arctan",
        "\\ln": "ln", "\\log": "log", "\\lim": "lim", "\\min": "min", "\\max": "max", "\\exp": "exp",
        "\\to": "→", "\\quad": "  ", "\\qquad": "    ", "\\;": " ", "\\,": " ", "\\!": ""
    };

    const sortedSymbolKeys = Object.keys(latexSymbols).sort((a, b) => b.length - a.length);

    // ========================================
    // RECURSIVE LATEX PARSER → Word Math Objects
    // ========================================

    /**
     * Extract content between matching braces { }
     */
    function extractBracedContent(text, startIndex) {
        if (text[startIndex] !== '{') return null;
        let depth = 0;
        for (let i = startIndex; i < text.length; i++) {
            if (text[i] === '{') depth++;
            if (text[i] === '}') depth--;
            if (depth === 0) {
                return { content: text.substring(startIndex + 1, i), newIndex: i + 1 };
            }
        }
        return null;
    }

    /**
     * Parse LaTeX string recursively to docx Math objects
     * Produces: MathRun, MathFraction, MathSuperScript, MathSubScript, MathRadical
     */
    function parseLatexRecursive(latex) {
        const nodes = [];
        let i = 0;
        let textBuffer = "";

        function flushBuffer() {
            if (textBuffer) {
                let processed = textBuffer;
                // Replace LaTeX symbols with unicode
                sortedSymbolKeys.forEach(key => {
                    if (processed.includes(key)) {
                        processed = processed.split(key).join(latexSymbols[key]);
                    }
                });
                // Remove remaining backslashes
                processed = processed.replace(/\\/g, "");
                if (processed.length > 0) {
                    nodes.push(new docx.MathRun(processed));
                }
                textBuffer = "";
            }
        }

        while (i < latex.length) {
            const char = latex[i];

            if (char === '\\') {
                flushBuffer();
                const remainder = latex.substring(i);

                // Handle \widehat → angle symbol
                if (remainder.startsWith("\\widehat")) {
                    let argStart = i + 8;
                    while (latex[argStart] === ' ') argStart++;
                    const arg = extractBracedContent(latex, argStart);
                    if (arg) {
                        nodes.push(new docx.MathRun("∠"));
                        nodes.push(...parseLatexRecursive(arg.content));
                        i = arg.newIndex;
                        continue;
                    }
                }

                // Handle \begin{cases}...\end{cases}
                if (remainder.startsWith("\\begin{cases}")) {
                    const endTag = "\\end{cases}";
                    const endIdx = latex.indexOf(endTag, i);
                    if (endIdx !== -1) {
                        const innerContent = latex.substring(i + 13, endIdx);
                        const casesLines = innerContent.split(/\\\\|\\/).map(l => l.trim()).filter(l => l !== "");
                        nodes.push(new docx.MathRun("{ "));
                        casesLines.forEach((line, idx) => {
                            nodes.push(...parseLatexRecursive(line));
                            if (idx < casesLines.length - 1) {
                                nodes.push(new docx.MathRun(" ; "));
                            }
                        });
                        i = endIdx + 11;
                        continue;
                    }
                }

                // Handle \frac{numerator}{denominator}
                if (remainder.startsWith("\\frac") || remainder.startsWith("\\dfrac")) {
                    const cmdLen = remainder.startsWith("\\dfrac") ? 6 : 5;
                    let startArg = i + cmdLen;
                    while (latex[startArg] === ' ') startArg++;
                    const firstArg = extractBracedContent(latex, startArg);
                    if (firstArg) {
                        let secondArgStart = firstArg.newIndex;
                        while (latex[secondArgStart] === ' ') secondArgStart++;
                        const secondArg = extractBracedContent(latex, secondArgStart);
                        if (secondArg) {
                            nodes.push(new docx.MathFraction({
                                numerator: parseLatexRecursive(firstArg.content),
                                denominator: parseLatexRecursive(secondArg.content)
                            }));
                            i = secondArg.newIndex;
                            continue;
                        }
                    }
                }

                // Handle \sqrt[n]{content} and \sqrt{content}
                if (remainder.startsWith("\\sqrt")) {
                    let degree = [];
                    let contentStart = i + 5;
                    if (latex[contentStart] === '[') {
                        const closeBracket = latex.indexOf(']', contentStart);
                        if (closeBracket > -1) {
                            degree = parseLatexRecursive(latex.substring(contentStart + 1, closeBracket));
                            contentStart = closeBracket + 1;
                        }
                    }
                    const arg = extractBracedContent(latex, contentStart);
                    if (arg) {
                        nodes.push(new docx.MathRadical({
                            degree: degree.length > 0 ? degree : undefined,
                            children: parseLatexRecursive(arg.content)
                        }));
                        i = arg.newIndex;
                        continue;
                    }
                }

                // Skip \left and \right (sizing commands)
                if (remainder.startsWith("\\left")) { i += 5; continue; }
                if (remainder.startsWith("\\right")) { i += 6; continue; }
                // Skip \text{...} — just output the text content
                if (remainder.startsWith("\\text")) {
                    let argStart = i + 5;
                    while (latex[argStart] === ' ') argStart++;
                    const arg = extractBracedContent(latex, argStart);
                    if (arg) {
                        nodes.push(new docx.MathRun(arg.content));
                        i = arg.newIndex;
                        continue;
                    }
                }
                // Skip \overline{...}
                if (remainder.startsWith("\\overline")) {
                    let argStart = i + 9;
                    while (latex[argStart] === ' ') argStart++;
                    const arg = extractBracedContent(latex, argStart);
                    if (arg) {
                        nodes.push(...parseLatexRecursive(arg.content));
                        nodes.push(new docx.MathRun("̅")); // combining overline
                        i = arg.newIndex;
                        continue;
                    }
                }

                textBuffer += char;
                i++;
            } else if (char === '^' || char === '_') {
                // Superscript / Subscript
                flushBuffer();
                const lastNode = nodes.pop();
                let scriptContent = [];
                let newIdx = i + 1;
                if (newIdx < latex.length) {
                    if (latex[newIdx] === '{') {
                        const extracted = extractBracedContent(latex, newIdx);
                        if (extracted) {
                            scriptContent = parseLatexRecursive(extracted.content);
                            newIdx = extracted.newIndex;
                        }
                    } else if (latex[newIdx] === '\\') {
                        const commandMatch = latex.substring(newIdx).match(/^(\\[a-zA-Z]+)/);
                        if (commandMatch) {
                            scriptContent = parseLatexRecursive(commandMatch[1]);
                            newIdx += commandMatch[1].length;
                        } else {
                            scriptContent = [new docx.MathRun("\\")];
                            newIdx++;
                        }
                    } else {
                        scriptContent = [new docx.MathRun(latex[newIdx])];
                        newIdx++;
                    }
                }
                const base = lastNode ? [lastNode] : [new docx.MathRun("")];
                if (char === '^') {
                    nodes.push(new docx.MathSuperScript({ children: base, superScript: scriptContent }));
                } else {
                    nodes.push(new docx.MathSubScript({ children: base, subScript: scriptContent }));
                }
                i = newIdx;
            } else {
                textBuffer += char;
                i++;
            }
        }
        flushBuffer();
        return nodes;
    }

    // ========================================
    // TEXT/MATH INLINE PARSER
    // ========================================

    /**
     * Parse text that contains $...$ inline math and $$...$$ display math
     * Returns array of TextRun and Math objects for docx Paragraph
     */
    function parseMathInText(text) {
        // Split text by math delimiters: $$...$$ and $...$
        const mathParts = text.split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$)/g);
        const result = [];

        mathParts.forEach(part => {
            const trimmed = part.trim();
            const isMath = /^\$\$[\s\S]*?\$\$|^\$[^$]*?\$$/.test(trimmed);

            if (isMath) {
                const mathContent = trimmed.replace(/^\${1,2}|\${1,2}$/g, "").trim();
                try {
                    result.push(new docx.Math({ children: parseLatexRecursive(mathContent) }));
                } catch (e) {
                    // Fallback: output as plain text with red color
                    result.push(new docx.TextRun({ text: trimmed, color: "FF0000" }));
                }
            } else if (part) {
                // Handle bold **text** and italic *text*
                const segments = part.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
                segments.forEach(seg => {
                    if (seg.startsWith('**') && seg.endsWith('**')) {
                        result.push(new docx.TextRun({ text: seg.slice(2, -2), bold: true }));
                    } else if (seg.startsWith('*') && seg.endsWith('*')) {
                        result.push(new docx.TextRun({ text: seg.slice(1, -1), italics: true }));
                    } else if (seg) {
                        result.push(new docx.TextRun({ text: seg }));
                    }
                });
            }
        });
        return result;
    }

    // ========================================
    // TABLE PARSER
    // ========================================
    function parseMarkdownTable(tableLines) {
        if (tableLines.length < 2) return null;
        // Filter out separator lines (|---|---|)
        const dataLines = tableLines.filter(line =>
            !/^\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)*\|?$/.test(line.trim())
        );

        const tableRows = dataLines.map(line => {
            const cells = line.split('|')
                .filter((_, idx, arr) =>
                    (idx > 0 && idx < arr.length - 1) ||
                    (idx === 0 && !line.startsWith('|')) ||
                    (idx === arr.length - 1 && !line.endsWith('|'))
                )
                .map(c => c.trim());

            if (cells.length === 0) return null;

            return new docx.TableRow({
                children: cells.map(cellText => new docx.TableCell({
                    children: [new docx.Paragraph({ children: parseMathInText(cellText) })],
                    width: { size: Math.floor(100 / cells.length), type: docx.WidthType.PERCENTAGE },
                    verticalAlign: docx.AlignmentType.CENTER
                }))
            });
        }).filter(row => row !== null);

        if (tableRows.length === 0) return null;

        return new docx.Table({
            rows: tableRows,
            width: { size: 100, type: docx.WidthType.PERCENTAGE },
            borders: {
                top: { style: docx.BorderStyle.SINGLE, size: 1 },
                bottom: { style: docx.BorderStyle.SINGLE, size: 1 },
                left: { style: docx.BorderStyle.SINGLE, size: 1 },
                right: { style: docx.BorderStyle.SINGLE, size: 1 },
                insideHorizontal: { style: docx.BorderStyle.SINGLE, size: 1 },
                insideVertical: { style: docx.BorderStyle.SINGLE, size: 1 },
            }
        });
    }

    // ========================================
    // EXPORT TO WORD
    // ========================================

    /**
     * Export text (with LaTeX math) to .docx file
     * @param {string} content - Text with $...$ LaTeX formulas
     * @param {string} fileName - Output filename (without extension)
     * @param {Object} options - { fontSize, fontName }
     */
    async function exportToWord(content, fileName = 'converted', options = {}) {
        const { fontSize = 24, fontName = 'Times New Roman' } = options;

        const children = [];

        // Title paragraph
        children.push(
            new docx.Paragraph({
                text: "TÀI LIỆU CHUYỂN ĐỔI TỪ PDF",
                heading: docx.HeadingLevel.HEADING_1,
                alignment: docx.AlignmentType.CENTER,
                spacing: { after: 200 }
            }),
            new docx.Paragraph({
                text: `Ngày tạo: ${new Date().toLocaleDateString("vi-VN")}`,
                alignment: docx.AlignmentType.CENTER,
                spacing: { after: 400 }
            })
        );

        // Parse content line by line
        const lines = content.split('\n');
        let tableBuffer = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Collect table lines
            if (line.startsWith('|')) {
                tableBuffer.push(lines[i]);
                continue;
            } else if (tableBuffer.length > 0) {
                const table = parseMarkdownTable(tableBuffer);
                if (table) children.push(table);
                tableBuffer = [];
            }

            if (line) {
                // Headings
                if (line.startsWith('### ')) {
                    children.push(new docx.Paragraph({
                        text: line.replace('### ', ''),
                        heading: docx.HeadingLevel.HEADING_3,
                        spacing: { before: 200, after: 100 }
                    }));
                } else if (line.startsWith('## ')) {
                    children.push(new docx.Paragraph({
                        text: line.replace('## ', ''),
                        heading: docx.HeadingLevel.HEADING_2,
                        spacing: { before: 240, after: 120 }
                    }));
                } else if (line.startsWith('# ')) {
                    children.push(new docx.Paragraph({
                        text: line.replace('# ', ''),
                        heading: docx.HeadingLevel.HEADING_1,
                        spacing: { before: 300, after: 150 }
                    }));
                } else if (line.match(/^---\s*Trang\s*\d+/i) || line === '---' || line === '========') {
                    // Page break
                    children.push(new docx.Paragraph({
                        children: [],
                        pageBreakBefore: true
                    }));
                } else {
                    // Normal paragraph with math parsing
                    children.push(new docx.Paragraph({
                        children: parseMathInText(lines[i]),
                        spacing: { after: 120, line: 360 },
                        alignment: docx.AlignmentType.BOTH
                    }));
                }
            } else {
                children.push(new docx.Paragraph({ text: "" }));
            }
        }

        // Flush remaining table
        if (tableBuffer.length > 0) {
            const table = parseMarkdownTable(tableBuffer);
            if (table) children.push(table);
        }

        // Create document
        const doc = new docx.Document({
            sections: [{
                properties: {},
                children: children
            }],
            styles: {
                default: {
                    document: {
                        run: {
                            font: fontName,
                            size: fontSize
                        }
                    }
                }
            }
        });

        const blob = await docx.Packer.toBlob(doc);
        saveAs(blob, `${fileName}.docx`);

        return { success: true, fileName: `${fileName}.docx` };
    }

    /**
     * Download text as TXT file
     */
    function downloadAsTxt(text, fileName = 'converted') {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        saveAs(blob, `${fileName}.txt`);
    }

    /**
     * Copy text to clipboard
     */
    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            // Fallback
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        }
    }

    /**
     * Batch export: each result to separate Word file
     */
    async function exportBatch(results, options = {}) {
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const name = `batch_${i + 1}_converted`;
            await exportToWord(r.text || '', name, options);
        }
    }

    // ========================================
    // PUBLIC API
    // ========================================
    return {
        exportToWord,
        exportBatch,
        downloadAsTxt,
        copyToClipboard,
        // Expose for testing
        parseLatexRecursive,
        parseMathInText
    };

})();
