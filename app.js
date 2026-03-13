/**
 * FotoPIM Web - Main Application Logic
 * Client-side image processing application
 */

// JSZip is loaded from CDN in index.html
// @ts-ignore
window.JSZip = window.JSZip || {};

// ===================================
// Constants
// ===================================

const VALID_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tiff', '.tif'];
const DEFAULT_THRESHOLD = 20;
const NUMBER_OF_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 8); // Max 8 workers
const DEFAULT_SETTINGS = {
    margin: 0,
    maxSide: 3000,
    minSize: 500,
    quality: 100,
    maxMb: 2.99,
    useMargin: true,
    useMaxSide: true,
    useMinSize: true,
    useMaxMb: true,
    baseName: '',
    startNumber: '1'
};

// ===================================
// State
// ===================================

const state = {
    files: [],                    // Array of file objects
    selectedFileIds: [],          // Array of selected file IDs (multi-select)
    lastSelectedIndex: -1,        // For shift+click range selection
    isProcessing: false,
    processedFiles: [],           // For ZIP download
    settings: { ...DEFAULT_SETTINGS, theme: 'light' },
    previewRequestId: 0           // For cancelling pending preview updates
};

// ===================================
// Web Worker Pool (jak ThreadPoolExecutor w Pythonie)
// ===================================
const workerPool = {
    workers: [],
    availableWorkers: [],
    taskQueue: [],
    initialized: false,

    init() {
        if (this.initialized) return;

        // Try to initialize workers
        try {
            for (let i = 0; i < NUMBER_OF_WORKERS; i++) {
                const worker = new Worker('worker.js');
                worker.onerror = (e) => {
                    console.warn('Worker error, falling back to main thread:', e);
                    this.workersDisabled = true;
                };
                worker.onmessage = (e) => this.handleWorkerMessage(i, e.data);
                this.workers.push(worker);
                this.availableWorkers.push(i);
            }
            this.initialized = true;
            console.log(`Worker pool initialized with ${NUMBER_OF_WORKERS} workers`);
        } catch (e) {
            console.warn('Cannot initialize workers (likely file:// protocol), using main thread:', e);
            this.workersDisabled = true;
            this.initialized = true;
        }
    },

    handleWorkerMessage(workerIndex, message) {
        const { type, data } = message;

        switch (type) {
            case 'THUMBNAIL_READY':
                this.onThumbnailReady?.(data);
                break;
            case 'THUMBNAIL_ERROR':
                console.error('Worker error:', data.error);
                this.onThumbnailError?.(data);
                break;
        }

        // Worker is now available
        this.availableWorkers.push(workerIndex);

        // Process next task in queue
        if (this.taskQueue.length > 0) {
            const nextTask = this.taskQueue.shift();
            this.assignTask(nextTask);
        }
    },

    assignTask(task) {
        const workerIndex = this.availableWorkers.shift();
        if (workerIndex === undefined) {
            // No workers available, queue the task
            this.taskQueue.push(task);
            return;
        }

        this.workers[workerIndex].postMessage(task);
    },

    generateThumbnail(fileObj) {
        return new Promise((resolve, reject) => {
            this.init();

            const taskId = fileObj.id;
            this.pendingTasks = this.pendingTasks || {};
            this.pendingTasks[taskId] = { resolve, reject };

            this.onThumbnailReady = (data) => {
                if (this.pendingTasks[data.id]) {
                    this.pendingTasks[data.id].resolve(data);
                    delete this.pendingTasks[data.id];
                }
            };

            this.onThumbnailError = (data) => {
                if (this.pendingTasks[data.id]) {
                    this.pendingTasks[data.id].reject(new Error(data.error));
                    delete this.pendingTasks[data.id];
                }
            };

            // Read file as ArrayBuffer
            const reader = new FileReader();
            reader.onload = (e) => {
                // Get original dimensions
                const img = new Image();
                img.onload = () => {
                    this.assignTask({
                        type: 'GENERATE_THUMBNAIL',
                        data: {
                            id: fileObj.id,
                            fileBuffer: e.target.result,
                            fileName: fileObj.name,
                            fileType: fileObj.file.type,
                            threshold: fileObj.threshold,
                            margin: state.settings.useMargin ? state.settings.margin : 0,
                            originalWidth: img.width,
                            originalHeight: img.height
                        }
                    });
                };
                img.src = URL.createObjectURL(fileObj.file);
            };
            reader.readAsArrayBuffer(fileObj.file);
        });
    }
};

// ===================================
// DOM Elements
// ===================================

const elements = {
    // Theme
    themeToggle: document.getElementById('themeToggle'),

    // Settings
    margin: document.getElementById('margin'),
    maxSide: document.getElementById('maxSide'),
    minSize: document.getElementById('minSize'),
    maxMb: document.getElementById('maxMb'),
    useMargin: document.getElementById('useMargin'),
    useMaxSide: document.getElementById('useMaxSide'),
    useMinSize: document.getElementById('useMinSize'),
    useMaxMb: document.getElementById('useMaxMb'),

    // Naming
    baseName: document.getElementById('baseName'),
    startNumber: document.getElementById('startNumber'),

    // Center Panel
    centerPanel: document.getElementById('centerPanel'),
    fileInput: document.getElementById('fileInput'),
    filesGrid: document.getElementById('filesGrid'),
    fileCount: document.getElementById('fileCount'),
    btnClearList: document.getElementById('btnClearList'),
    btnDeleteSelected: document.getElementById('btnDeleteSelected'),
    emptyState: document.getElementById('emptyState'),

    // Right Panel
    previewPlaceholder: document.getElementById('previewPlaceholder'),
    previewImageContainer: document.getElementById('previewImageContainer'),
    previewCanvas: document.getElementById('previewCanvas'),
    previewThreshold: document.getElementById('previewThreshold'),
    thresholdSlider: document.getElementById('thresholdSlider'),

    // Actions
    btnStartProcessing: document.getElementById('btnStartProcessing'),
    btnProcessSingle: document.getElementById('btnProcessSingle'),
    btnDownloadZip: document.getElementById('btnDownloadZip'),
    btnCancelProcessing: document.getElementById('btnCancelProcessing'),

    // Progress
    progressOverlay: document.getElementById('progressOverlay'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    progressStatus: document.getElementById('progressStatus'),

    // Toast
    toastContainer: document.getElementById('toastContainer')
};

// ===================================
// Utility Functions
// ===================================

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileExtension(filename) {
    return '.' + filename.split('.').pop().toLowerCase();
}

function isValidImageFile(filename) {
    return VALID_EXTENSIONS.includes(getFileExtension(filename));
}

function slugify(text) {
    if (!text) return '';
    const plMap = {
        'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
        'Ą': 'A', 'Ć': 'C', 'Ę': 'E', 'Ł': 'L', 'Ń': 'N', 'Ó': 'O', 'Ś': 'S', 'Ź': 'Z', 'Ż': 'Z'
    };
    let result = text;
    for (const [key, value] of Object.entries(plMap)) {
        result = result.replace(new RegExp(key, 'g'), value);
    }
    result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    result = result.replace(/[^a-zA-Z0-9]/g, '-');
    result = result.replace(/-+/g, '-');
    return result.replace(/^-|-$/g, '');
}

// ===================================
// Toast Notifications
// ===================================

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-message">${message}</span>`;
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ===================================
// Theme Management
// ===================================

function initTheme() {
    const savedTheme = localStorage.getItem('fotopim-theme') || 'light';
    setTheme(savedTheme);
}

function setTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('fotopim-theme', theme);
}

function toggleTheme() {
    const newTheme = state.theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
}

// ===================================
// Settings Management
// ===================================

function loadSettings() {
    const saved = localStorage.getItem('fotopim-settings');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            delete parsed.baseName;
            delete parsed.startNumber;
            delete parsed.threshold;
            state.settings = { ...DEFAULT_SETTINGS, ...parsed };
        } catch (e) {
            console.error('Error loading settings:', e);
        }
    }
    applySettingsToUI();
}

function saveSettings() {
    const settingsToSave = { ...state.settings };
    // Don't save folder paths for security
    delete settingsToSave.inputFolder;
    delete settingsToSave.outputFolder;
    // Don't save naming fields (user-specific for each session)
    delete settingsToSave.baseName;
    delete settingsToSave.startNumber;
    // Don't save threshold (each file has its own threshold)
    delete settingsToSave.threshold;
    localStorage.setItem('fotopim-settings', JSON.stringify(settingsToSave));
}

function applySettingsToUI() {
    const s = state.settings;
    elements.margin.value = s.margin;
    elements.maxSide.value = s.maxSide;
    elements.minSize.value = s.minSize;
    elements.maxMb.value = s.maxMb;
    elements.useMargin.checked = s.useMargin;
    elements.useMaxSide.checked = s.useMaxSide;
    elements.useMinSize.checked = s.useMinSize;
    elements.useMaxMb.checked = s.useMaxMb;
    // Don't restore baseName and startNumber - user enters them each session
    // elements.baseName.value = s.baseName;
    // elements.startNumber.value = s.startNumber;
}

function updateSettingsFromUI() {
    state.settings = {
        margin: parseInt(elements.margin.value) || 0,
        threshold: state.settings.threshold || 10, // Preserve current threshold
        maxSide: parseInt(elements.maxSide.value) || 3000,
        minSize: parseInt(elements.minSize.value) || 500,
        quality: 100, // Fixed quality value
        maxMb: parseFloat(elements.maxMb.value) || 2.99,
        useMargin: elements.useMargin.checked,
        useMaxSide: elements.useMaxSide.checked,
        useMinSize: elements.useMinSize.checked,
        useMaxMb: elements.useMaxMb.checked,
        baseName: elements.baseName.value,
        startNumber: elements.startNumber.value
    };
    saveSettings();
    updateFileNames();
}

// ===================================
// File Handling
// ===================================

function addFiles(newFiles) {
    const validFiles = Array.from(newFiles).filter(f => isValidImageFile(f.name));

    if (validFiles.length === 0) {
        showToast('Brak prawidłowych plików graficznych', 'warning');
        return;
    }

    let addedCount = 0;

    validFiles.forEach(file => {
        // Check if file already exists
        const exists = state.files.some(f => f.name === file.name && f.size === file.size);
        if (!exists) {
            const fileObj = {
                id: generateId(),
                file: file,
                name: file.name,
                baseName: file.name,
                size: file.size,
                sizeStr: formatSize(file.size),
                resolution: null,
                trimmedResolution: null,
                newName: '',
                lifestyle: false,
                status: 'pending',
                thumbnail: null,
                threshold: state.settings.threshold || DEFAULT_THRESHOLD,
                processedData: null,
                loadedImage: null,  // Cached image for preview
                cachedImageData: null,
                bbox: null
            };
            state.files.push(fileObj);

            // Add to DOM immediately
            const card = createFileCard(fileObj, state.files.length - 1);
            elements.filesGrid.appendChild(card);

            addedCount++;
        }
    });

    if (addedCount > 0) {
        showToast(`Dodano ${addedCount} plików`, 'success');
        updateUIState();
        updateFileNames();
    }
}

function updateUIState() {
    elements.fileCount.textContent = `${state.files.length} plików`;

    if (state.files.length === 0) {
        elements.emptyState.style.display = 'flex';
        elements.btnStartProcessing.disabled = true;
        elements.btnProcessSingle.disabled = true;
    } else {
        elements.emptyState.style.display = 'none';
        elements.btnStartProcessing.disabled = false;
        elements.btnProcessSingle.disabled = false;
    }
}

function removeFile(id) {
    state.files = state.files.filter(f => f.id !== id);
    state.selectedFileIds = state.selectedFileIds.filter(sid => sid !== id);

    const row = document.querySelector(`.file-row[data-id="${id}"]`);
    if (row) row.remove();

    updateUIState();
    updateFileNames();
}

function removeSelectedFiles() {
    // Zbierz wszystkie ID do usunięcia
    const idsToDelete = new Set(state.selectedFileIds);

    // Dodaj pliki z zaznaczonym checkboxem Lifestyle
    state.files.forEach(f => {
        if (f.lifestyle) {
            idsToDelete.add(f.id);
        }
    });

    if (idsToDelete.size === 0) return;

    const count = idsToDelete.size;

    // Usuń wiersze z DOM
    idsToDelete.forEach(id => {
        const row = document.querySelector(`.file-row[data-id="${id}"]`);
        if (row) row.remove();
    });

    // Usuń z tablicy files
    state.files = state.files.filter(f => !idsToDelete.has(f.id));
    state.selectedFileIds = [];
    state.lastSelectedIndex = -1;

    updateUIState();
    updateFileNames();
    clearPreview();
    showToast(`Usunięto ${count} plików`, 'success');
}

function deselectAllFiles() {
    state.selectedFileIds = [];
    state.lastSelectedIndex = -1;

    document.querySelectorAll('.file-row').forEach(row => {
        row.classList.remove('selected');
    });

    updateSelectionCount();
    clearPreview();
}

function clearFiles() {
    state.files = [];
    state.selectedFileIds = [];
    state.lastSelectedIndex = -1;
    elements.filesGrid.innerHTML = '';
    updateUIState();
    clearPreview();
}

// ===================================
// File Rendering
// ===================================

function renderFiles() {
    elements.filesGrid.innerHTML = '';

    state.files.forEach((fileObj, index) => {
        const card = createFileCard(fileObj, index);
        elements.filesGrid.appendChild(card);
    });

    updateUIState();
}

function createFileCard(fileObj, index) {
    const row = document.createElement('div');
    row.className = `file-row ${state.selectedFileIds.includes(fileObj.id) ? 'selected' : ''}`;
    row.dataset.id = fileObj.id;
    row.dataset.index = index;
    row.draggable = true;  // Enable drag for reordering

    row.innerHTML = `
        <div class="cell cell-preview">
            <img src="" alt="${fileObj.name}" loading="lazy" draggable="false">
            <span class="preview-resolution">${fileObj.resolution || '-'}</span>
        </div>
        <div class="cell cell-trimmed" title="Rozdzielczość po kadrowaniu (Próg: ${fileObj.threshold})">
            ${fileObj.trimmedResolution || '-'}
        </div>
        <div class="cell cell-size">${fileObj.sizeStr || '-'}</div>
        <div class="cell cell-newname" title="${fileObj.newName || '-'}">
            ${fileObj.newName || '-'}
        </div>
        <div class="cell cell-checkbox">
            <input type="checkbox" ${fileObj.lifestyle ? 'checked' : ''}>
        </div>
    `;

    // Generate thumbnail
    generateThumbnail(fileObj).then(thumbnail => {
        if (thumbnail) {
            row.querySelector('img').src = thumbnail;
        }
    });

    // Event listeners
    row.addEventListener('click', (e) => {
        if (e.target.type !== 'checkbox') {
            selectFile(fileObj.id, index, e.ctrlKey || e.metaKey, e.shiftKey);
        }
    });

    // Drag and drop for reordering
    row.addEventListener('dragstart', (e) => {
        if (e.target.type === 'checkbox') {
            e.preventDefault();
            return;
        }
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.dataset.id);
    });

    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        document.querySelectorAll('.file-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    });

    row.addEventListener('dragover', (e) => {
        // If it's a file drop, let it bubble up to centerPanel
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
            return;
        }

        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    });

    row.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (!row.classList.contains('dragging')) {
            row.classList.add('drag-over');
        }
    });

    row.addEventListener('dragleave', (e) => {
        if (!row.contains(e.relatedTarget)) {
            row.classList.remove('drag-over');
        }
    });

    row.addEventListener('drop', (e) => {
        // If it's a file drop, let it bubble up to centerPanel
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const targetRow = e.target.closest('.file-row');
        if (targetRow) {
            targetRow.classList.remove('drag-over');

            const draggedId = e.dataTransfer.getData('text/plain');
            const targetId = targetRow.dataset.id;

            if (draggedId && draggedId !== targetId) {
                const draggedIndex = state.files.findIndex(f => f.id === draggedId);
                const targetIndex = state.files.findIndex(f => f.id === targetId);

                if (draggedIndex !== -1 && targetIndex !== -1) {
                    // Remove from old position and insert at new position
                    const [draggedFile] = state.files.splice(draggedIndex, 1);
                    state.files.splice(targetIndex, 0, draggedFile);

                    // Update file names based on new order
                    updateFileNames();

                    // Move DOM element instead of re-rendering all rows
                    const draggedRow = document.querySelector(`.file-row[data-id="${draggedId}"]`);
                    if (draggedRow) {
                        if (draggedIndex < targetIndex) {
                            targetRow.after(draggedRow);
                        } else {
                            targetRow.before(draggedRow);
                        }
                        // Update newname cells based on current state
                        document.querySelectorAll('.cell-newname').forEach((el, idx) => {
                            if (state.files[idx]) {
                                el.textContent = state.files[idx].newName || state.files[idx].name;
                            }
                        });
                    }
                }
            }
        }
        return false;
    });

    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        toggleLifestyle(fileObj.id);
    });

    return row;
}

async function generateThumbnail(fileObj) {
    if (fileObj.thumbnail && fileObj.lastThumbThreshold === fileObj.threshold) {
        return fileObj.thumbnail;
    }

    // If workers are disabled (file:// protocol), use main thread directly
    if (workerPool.workersDisabled) {
        return await generateThumbnailMainThread(fileObj);
    }

    try {
        // Użyj Worker Pool do przetwarzania w tle (jak ThreadPoolExecutor w Pythonie)
        const result = await workerPool.generateThumbnail(fileObj);

        // Convert ArrayBuffer back to DataURL
        const blob = new Blob([result.thumbnailBuffer], { type: 'image/jpeg' });
        const dataUrl = await blobToDataURL(blob);

        fileObj.thumbnail = dataUrl;
        fileObj.trimmedResolution = result.trimmedResolution;
        fileObj.bbox = result.bbox;
        fileObj.lastThumbThreshold = fileObj.threshold;

        // Update resolution in table
        const row = document.querySelector(`.file-row[data-id="${fileObj.id}"]`);
        if (row) {
            const resEl = row.querySelector('.preview-resolution');
            if (resEl) resEl.textContent = fileObj.resolution;
            const trimmedEl = row.querySelector('.cell-trimmed');
            if (trimmedEl) trimmedEl.textContent = fileObj.trimmedResolution;
        }

        return fileObj.thumbnail;

    } catch (e) {
        console.warn('Worker failed, fallback to main thread:', e);
        // Fallback do głównej funkcji
        return await generateThumbnailMainThread(fileObj);
    }
}

// Fallback funkcja na głównym wątku
async function generateThumbnailMainThread(fileObj) {
    if (fileObj.thumbnail && fileObj.lastThumbThreshold === fileObj.threshold) {
        return fileObj.thumbnail;
    }

    // KLUCZOWE: Generuj od razu podgląd (1200px) zamiast małej miniatury (600px)
    // Dzięki temu przy pierwszym kliknięciu podgląd będzie już gotowy!
    const previewPanel = document.getElementById('rightPanel');
    const containerWidth = previewPanel ? previewPanel.clientWidth : 600;
    const PREVIEW_MAX_SIZE = Math.max(containerWidth - 40, 800);

    let img, originalWidth, originalHeight, scaleForPreview = 1;

    const fileData = await fileObj.file.arrayBuffer();
    const blob = new Blob([fileData], { type: fileObj.file.type });

    try {
        if (!fileObj.resolution) {
            const metaImg = await new Promise((resolve) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.src = URL.createObjectURL(blob);
            });
            originalWidth = metaImg.width;
            originalHeight = metaImg.height;
            fileObj.resolution = `${originalWidth}x${originalHeight}`;
            URL.revokeObjectURL(metaImg.src);
        } else {
            const parts = fileObj.resolution.split('x');
            originalWidth = parseInt(parts[0]);
            originalHeight = parseInt(parts[1]);
        }

        const maxDim = Math.max(originalWidth, originalHeight);
        if (maxDim > PREVIEW_MAX_SIZE) {
            scaleForPreview = PREVIEW_MAX_SIZE / maxDim;
        }

        const targetWidth = Math.floor(originalWidth * scaleForPreview);
        const targetHeight = Math.floor(originalHeight * scaleForPreview);

        if (targetWidth < originalWidth) {
            img = await createImageBitmap(blob, {
                resizeWidth: targetWidth,
                resizeHeight: targetHeight,
                resizeQuality: 'high'
            });
        } else {
            img = await createImageBitmap(blob);
        }

        // KLUCZOWE: ZAPISZ previewImage - podgląd będzie gotowy od razu!
        fileObj.previewImage = img;
        fileObj.previewOriginalWidth = originalWidth;
        fileObj.previewOriginalHeight = originalHeight;
        fileObj.previewMaxSize = PREVIEW_MAX_SIZE;
        fileObj.loadedImage = img; // Dla kompatybilności

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.width;
        tempCanvas.height = img.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(img, 0, 0);
        // Nie zamykaj img - jest używany jako previewImage!

        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);

        const margin = state.settings.useMargin ? state.settings.margin : 0;
        const bbox = trimWhitespace(imageData, fileObj.threshold, margin);

        const scaledBbox = {
            left: Math.floor(bbox.left / scaleForPreview),
            top: Math.floor(bbox.top / scaleForPreview),
            right: Math.ceil(bbox.right / scaleForPreview),
            bottom: Math.ceil(bbox.bottom / scaleForPreview)
        };

        const trimmedWidth = scaledBbox.right - scaledBbox.left + 1;
        const trimmedHeight = scaledBbox.bottom - scaledBbox.top + 1;
        fileObj.trimmedResolution = `${trimmedWidth}x${trimmedHeight}`;
        fileObj.bbox = scaledBbox;

        const canvas = document.createElement('canvas');
        const size = 150;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const thumbScale = Math.min(size / (bbox.right - bbox.left + 1), size / (bbox.bottom - bbox.top + 1));
        const w = (bbox.right - bbox.left + 1) * thumbScale;
        const h = (bbox.bottom - bbox.top + 1) * thumbScale;
        const x = (size - w) / 2;
        const y = (size - h) / 2;

        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(tempCanvas, bbox.left, bbox.top, bbox.right - bbox.left + 1, bbox.bottom - bbox.top + 1, x, y, w, h);

        fileObj.thumbnail = canvas.toDataURL('image/jpeg', 0.7);
        fileObj.lastThumbThreshold = fileObj.threshold;

        const row = document.querySelector(`.file-row[data-id="${fileObj.id}"]`);
        if (row) {
            const resEl = row.querySelector('.preview-resolution');
            if (resEl) resEl.textContent = fileObj.resolution;
            const trimmedEl = row.querySelector('.cell-trimmed');
            if (trimmedEl) trimmedEl.textContent = fileObj.trimmedResolution;
        }

        return fileObj.thumbnail;

    } catch (e) {
        console.error('generateThumbnailMainThread failed:', e);
        return null;
    }
}

// Helper: Convert Blob to DataURL
function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ===================================
// File Selection & Preview
// ===================================

function selectFile(id, index, ctrlKey, shiftKey) {
    if (shiftKey && state.lastSelectedIndex !== -1) {
        // Range selection with Shift
        const startIdx = Math.min(state.lastSelectedIndex, index);
        const endIdx = Math.max(state.lastSelectedIndex, index);

        if (!ctrlKey) {
            state.selectedFileIds = [];
        }

        for (let i = startIdx; i <= endIdx; i++) {
            if (!state.selectedFileIds.includes(state.files[i].id)) {
                state.selectedFileIds.push(state.files[i].id);
            }
        }
    } else if (ctrlKey) {
        // Toggle selection with Ctrl
        const idx = state.selectedFileIds.indexOf(id);
        if (idx !== -1) {
            state.selectedFileIds.splice(idx, 1);
        } else {
            state.selectedFileIds.push(id);
        }
        state.lastSelectedIndex = index;
    } else {
        // Normal click - single selection
        state.selectedFileIds = [id];
        state.lastSelectedIndex = index;
    }

    // Update UI
    document.querySelectorAll('.file-row').forEach(row => {
        row.classList.toggle('selected', state.selectedFileIds.includes(row.dataset.id));
    });

    // Show preview for last selected file
    if (state.selectedFileIds.length > 0) {
        showPreview(state.selectedFileIds[state.selectedFileIds.length - 1]);
    } else {
        clearPreview();
    }

    updateSelectionCount();
}

function updateSelectionCount() {
    const count = state.selectedFileIds.length;
    if (elements.btnDeleteSelected) {
        elements.btnDeleteSelected.style.display = count > 0 ? 'inline-flex' : 'none';
    }
}

async function showPreview(id) {
    const fileObj = state.files.find(f => f.id === id);
    if (!fileObj) return;

    // Cancel any pending preview by incrementing request ID
    const currentRequestId = ++state.previewRequestId;

    elements.previewPlaceholder.style.display = 'none';
    elements.previewImageContainer.style.display = 'flex';
    elements.previewThreshold.style.display = 'block';

    // Update threshold slider only if not already at that value to avoid jitter
    if (parseInt(elements.thresholdSlider.value) !== fileObj.threshold) {
        elements.thresholdSlider.value = fileObj.threshold;
    }

    // Helper function to draw preview
    const drawPreview = (img, imageData, originalWidth, originalHeight) => {
        if (currentRequestId !== state.previewRequestId) return;

        const canvas = elements.previewCanvas;
        const ctx = canvas.getContext('2d');

        // Check if we're working with a downscaled image
        const isDownscaled = originalWidth && img.width < originalWidth;
        const scale = isDownscaled ? img.width / originalWidth : 1;

        // Calculate bbox with current threshold and margin
        // If we don't have imageData yet, we need to get it
        if (!imageData) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(img, 0, 0);
            imageData = tempCtx.getImageData(0, 0, img.width, img.height);
            // Cache it for subsequent threshold changes
            fileObj.cachedImageData = imageData;
        }

        const margin = state.settings.useMargin ? state.settings.margin : 0;
        const bbox = trimWhitespace(imageData, fileObj.threshold, margin);

        // Scale bbox back to original if we're working with downscaled image
        let finalBbox = bbox;
        if (scale && scale < 1) {
            finalBbox = {
                left: Math.floor(bbox.left / scale),
                top: Math.floor(bbox.top / scale),
                right: Math.ceil(bbox.right / scale),
                bottom: Math.ceil(bbox.bottom / scale)
            };
        }

        const trimmedWidth = finalBbox.right - finalBbox.left + 1;
        const trimmedHeight = finalBbox.bottom - finalBbox.top + 1;

        // Store bbox and trimmed resolution in fileObj
        fileObj.bbox = finalBbox;
        fileObj.trimmedResolution = `${trimmedWidth}x${trimmedHeight}`;

        // Update the trimmed cell in the table without full re-render
        const row = document.querySelector(`.file-row[data-id="${fileObj.id}"]`);
        if (row) {
            const trimmedCell = row.querySelector('.cell-trimmed');
            if (trimmedCell) {
                trimmedCell.textContent = fileObj.trimmedResolution;
            }
        }

        // Force layout update before getting dimensions
        elements.previewImageContainer.offsetHeight;
        let containerWidth = elements.previewImageContainer.clientWidth;
        let containerHeight = elements.previewImageContainer.clientHeight;

        // Fallback if dimensions are 0
        if (containerWidth < 100) containerWidth = 280;
        if (containerHeight < 100) containerHeight = 400;

        // Calculate scale to fit trimmed image in container, allowing it to SCALE UP
        const displayScale = Math.min(containerWidth / trimmedWidth, containerHeight / trimmedHeight);
        const displayWidth = Math.floor(trimmedWidth * displayScale);
        const displayHeight = Math.floor(trimmedHeight * displayScale);

        canvas.width = displayWidth;
        canvas.height = displayHeight;

        // Draw background
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(0, 0, displayWidth, displayHeight);

        // Draw from the (possibly downscaled) image using scaled bbox
        // If we have a downscaled image, bbox is already in that coordinate space
        const sourceBbox = (scale && scale < 1) ? bbox : finalBbox;
        const sourceTrimmedWidth = sourceBbox.right - sourceBbox.left + 1;
        const sourceTrimmedHeight = sourceBbox.bottom - sourceBbox.top + 1;

        ctx.drawImage(
            img,
            sourceBbox.left, sourceBbox.top, sourceTrimmedWidth, sourceTrimmedHeight,
            0, 0, displayWidth, displayHeight
        );

        // Update thumbnail in list
        const listImg = row ? row.querySelector('.cell-preview img') : null;
        if (listImg) {
            const thumbCanvas = document.createElement('canvas');
            const thumbSize = 150;
            thumbCanvas.width = thumbSize;
            thumbCanvas.height = thumbSize;
            const thumbCtx = thumbCanvas.getContext('2d');

            const tScale = Math.min(thumbSize / trimmedWidth, thumbSize / trimmedHeight);
            const tw = trimmedWidth * tScale;
            const th = trimmedHeight * tScale;
            const tx = (thumbSize - tw) / 2;
            const ty = (thumbSize - th) / 2;

            thumbCtx.fillStyle = '#e5e7eb';
            thumbCtx.fillRect(0, 0, thumbSize, thumbSize);
            thumbCtx.drawImage(img, sourceBbox.left, sourceBbox.top, sourceTrimmedWidth, sourceTrimmedHeight, tx, ty, tw, th);

            const thumbData = thumbCanvas.toDataURL('image/jpeg', 0.7);
            listImg.src = thumbData;
            fileObj.thumbnail = thumbData;
            fileObj.lastThumbThreshold = fileObj.threshold;
        }
    };

    // Use cached preview image if available (downscaled version for preview)
    if (fileObj.previewImage) {
        drawPreview(
            fileObj.previewImage,
            fileObj.cachedImageData,
            fileObj.previewOriginalWidth,
            fileObj.previewOriginalHeight
        );
        return;
    }

    // KLUCZOWE: Downsample przy dekodowaniu (jak PyVips thumbnail_image)
    // Nie ładuj całego 50MB obrazu!
    loadPreviewImage(fileObj).then(({ img, originalWidth, originalHeight }) => {
        if (currentRequestId !== state.previewRequestId) return;

        // loadedImage teraz to downscaled wersja (dla kompatybilności)
        fileObj.loadedImage = img;
        fileObj.resolution = `${originalWidth}x${originalHeight}`;
        drawPreview(img, null, originalWidth, originalHeight);
    }).catch(err => {
        console.error('Failed to load preview:', err);
    });
}

// Nowa funkcja do szybkiego ładowania podglądu z downsampling
async function loadPreviewImage(fileObj) {
    // KLUCZOWE: Dynamiczny rozmiar na podstawie szerokości panelu podglądu!
    const previewPanel = document.getElementById('rightPanel');
    const containerWidth = previewPanel ? previewPanel.clientWidth : 600;
    // Dodaj margines na padding i toolbar
    const PREVIEW_MAX_SIZE = Math.max(containerWidth - 40, 400);

    // Sprawdź czy mamy już cache z odpowiednim rozmiarem
    if (fileObj.previewImage && fileObj.previewMaxSize >= PREVIEW_MAX_SIZE) {
        // Cache hit - mamy już obraz w odpowiednim rozmiarze
        return {
            img: fileObj.previewImage,
            originalWidth: fileObj.previewOriginalWidth,
            originalHeight: fileObj.previewOriginalHeight
        };
    }

    // Cache miss - ładuj i zapisz do cache
    const fileBuffer = await fileObj.file.arrayBuffer();
    const blob = new Blob([fileBuffer], { type: fileObj.file.type });

    // Pobierz wymiary oryginału
    let originalWidth, originalHeight;
    if (fileObj.resolution) {
        const parts = fileObj.resolution.split('x');
        originalWidth = parseInt(parts[0]);
        originalHeight = parseInt(parts[1]);
    } else {
        // Szybkie pobranie wymiarów
        const metaImg = await new Promise(resolve => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.src = URL.createObjectURL(blob);
        });
        originalWidth = metaImg.width;
        originalHeight = metaImg.height;
        URL.revokeObjectURL(metaImg.src);
        fileObj.resolution = `${originalWidth}x${originalHeight}`;
    }

    const maxDim = Math.max(originalWidth, originalHeight);
    const scale = maxDim > PREVIEW_MAX_SIZE ? PREVIEW_MAX_SIZE / maxDim : 1;
    const targetWidth = Math.floor(originalWidth * scale);
    const targetHeight = Math.floor(originalHeight * scale);

    // DEKODUJ OD RAZU DO MAŁEGO ROZMIARU!
    const img = await createImageBitmap(blob, {
        resizeWidth: targetWidth,
        resizeHeight: targetHeight,
        resizeQuality: 'high'
    });

    // ZAPISZ DO CACHE - kolejne kliknięcia będą błyskawiczne!
    fileObj.previewImage = img;
    fileObj.previewOriginalWidth = originalWidth;
    fileObj.previewOriginalHeight = originalHeight;
    fileObj.previewMaxSize = PREVIEW_MAX_SIZE;

    return { img, originalWidth, originalHeight };
}

function clearPreview() {
    elements.previewPlaceholder.style.display = 'flex';
    elements.previewImageContainer.style.display = 'none';
    elements.previewThreshold.style.display = 'none';

    const canvas = elements.previewCanvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function toggleLifestyle(id) {
    const fileObj = state.files.find(f => f.id === id);
    if (fileObj) {
        fileObj.lifestyle = !fileObj.lifestyle;

        // Update DOM directly
        const row = document.querySelector(`.file-row[data-id="${id}"]`);
        if (row) {
            const checkbox = row.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.checked = fileObj.lifestyle;
        }

        updateFileNames();
    }
}

function selectAllLifestyle() {
    const allChecked = state.files.every(f => f.lifestyle);
    state.files.forEach(f => {
        f.lifestyle = !allChecked;
    });
    updateFileNames();
    renderFiles();
}

// ===================================
// File Naming
// ===================================

function updateFileNames() {
    const baseName = slugify(state.settings.baseName);
    const startNumStr = state.settings.startNumber;

    // Parse start number
    const match = startNumStr.match(/^(.*?)(\d+)$/);
    let prefix = startNumStr;
    let startNum = 1;
    let padding = 1;

    if (match) {
        prefix = match[1];
        startNum = parseInt(match[2]);
        padding = match[2].length;
    }

    state.files.forEach((fileObj, index) => {
        if (!baseName) {
            // No base name provided - show original name
            fileObj.newName = fileObj.name;
            fileObj.baseName = '';
            return;
        }

        // Update base name
        fileObj.baseName = baseName;

        const suffix = fileObj.lifestyle ? '-lifestyle' : '';
        const num = startNum + index;
        const formattedNum = String(num).padStart(padding, '0');

        fileObj.newName = `${baseName}${suffix}-${prefix}${formattedNum}.jpg`;
    });

    // Update UI
    document.querySelectorAll('.cell-newname').forEach((el, index) => {
        if (state.files[index]) {
            const displayName = state.files[index].newName || state.files[index].name;
            el.textContent = displayName;
            el.title = displayName;
        }
    });
}

// ===================================
// Image Processing
// ===================================

function trimWhitespace(imageData, threshold, margin) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    let top = 0, bottom = height - 1;
    let left = 0, right = width - 1;

    // Target threshold: pixels where at least one channel is darker than (255 - threshold)
    // are considered part of the image (not background)
    const t = 255 - threshold;

    // Find top
    outerTop:
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            // Check Alpha if present, otherwise just RGB
            if (data[i + 3] > 0 && (data[i] < t || data[i + 1] < t || data[i + 2] < t)) {
                top = y;
                break outerTop;
            }
        }
    }

    // Find bottom
    outerBottom:
    for (let y = height - 1; y >= 0; y--) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] > 0 && (data[i] < t || data[i + 1] < t || data[i + 2] < t)) {
                bottom = y;
                break outerBottom;
            }
        }
    }

    // Find left
    outerLeft:
    for (let x = 0; x < width; x++) {
        for (let y = top; y <= bottom; y++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] > 0 && (data[i] < t || data[i + 1] < t || data[i + 2] < t)) {
                left = x;
                break outerLeft;
            }
        }
    }

    // Find right
    outerRight:
    for (let x = width - 1; x >= 0; x--) {
        for (let y = top; y <= bottom; y++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] > 0 && (data[i] < t || data[i + 1] < t || data[i + 2] < t)) {
                right = x;
                break outerRight;
            }
        }
    }

    // Apply margin
    left = Math.max(0, left - margin);
    top = Math.max(0, top - margin);
    right = Math.min(width - 1, right + margin);
    bottom = Math.min(height - 1, bottom + margin);

    return { left, top, right, bottom };
}

async function processImage(fileObj, settings) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const imgUrl = URL.createObjectURL(fileObj.file);

        img.onload = () => {
            try {
                // Cleanup URL
                URL.revokeObjectURL(imgUrl);

                // Create canvas
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                // 1. Trim whitespace
                let workingCanvas = document.createElement('canvas');
                let workingCtx = workingCanvas.getContext('2d');
                workingCanvas.width = img.width;
                workingCanvas.height = img.height;
                workingCtx.drawImage(img, 0, 0);

                if (settings.useMargin) {
                    const imageData = workingCtx.getImageData(0, 0, workingCanvas.width, workingCanvas.height);
                    const bbox = trimWhitespace(imageData, fileObj.threshold, settings.margin);

                    if (bbox.right > bbox.left && bbox.bottom > bbox.top) {
                        workingCanvas = document.createElement('canvas');
                        workingCtx = workingCanvas.getContext('2d');
                        workingCanvas.width = bbox.right - bbox.left + 1;
                        workingCanvas.height = bbox.bottom - bbox.top + 1;
                        workingCtx.drawImage(img, bbox.left, bbox.top, workingCanvas.width, workingCanvas.height, 0, 0, workingCanvas.width, workingCanvas.height);
                    }
                }

                let finalWidth = workingCanvas.width;
                let finalHeight = workingCanvas.height;

                // 2. Resize if needed
                if (settings.useMaxSide) {
                    if (finalWidth > settings.maxSide || finalHeight > settings.maxSide) {
                        const scale = settings.maxSide / Math.max(finalWidth, finalHeight);
                        finalWidth = Math.floor(finalWidth * scale);
                        finalHeight = Math.floor(finalHeight * scale);

                        const resizedCanvas = document.createElement('canvas');
                        resizedCanvas.width = finalWidth;
                        resizedCanvas.height = finalHeight;
                        const resizedCtx = resizedCanvas.getContext('2d');
                        resizedCtx.drawImage(workingCanvas, 0, 0, finalWidth, finalHeight);
                        workingCanvas = resizedCanvas;
                        workingCtx = resizedCtx;
                    }
                }

                // 3. Pad to min size
                if (settings.useMinSize) {
                    if (finalWidth < settings.minSize || finalHeight < settings.minSize) {
                        const newWidth = Math.max(finalWidth, settings.minSize);
                        const newHeight = Math.max(finalHeight, settings.minSize);

                        const paddedCanvas = document.createElement('canvas');
                        paddedCanvas.width = newWidth;
                        paddedCanvas.height = newHeight;
                        const paddedCtx = paddedCanvas.getContext('2d');

                        // Fill with white
                        paddedCtx.fillStyle = '#ffffff';
                        paddedCtx.fillRect(0, 0, newWidth, newHeight);

                        // Center the image
                        const x = Math.floor((newWidth - finalWidth) / 2);
                        const y = Math.floor((newHeight - finalHeight) / 2);
                        paddedCtx.drawImage(workingCanvas, x, y);

                        workingCanvas = paddedCanvas;
                        workingCtx = paddedCtx;
                        finalWidth = newWidth;
                        finalHeight = newHeight;
                    }
                }

                // 4. Convert to JPEG with quality
                canvas.width = finalWidth;
                canvas.height = finalHeight;

                // KLUCZOWE: JPEG nie obsługuje transparency - wypełnij białym tłem
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, finalWidth, finalHeight);
                // Potem narysuj obraz na białym tle
                ctx.drawImage(workingCanvas, 0, 0);

                // Get blob
                canvas.toBlob((blob) => {
                    if (blob) {
                        resolve({
                            blob,
                            width: finalWidth,
                            height: finalHeight,
                            size: blob.size
                        });
                    } else {
                        reject(new Error('Failed to create blob'));
                    }
                }, 'image/jpeg', settings.quality / 100);

            } catch (e) {
                URL.revokeObjectURL(imgUrl);
                reject(e);
            }
        };

        img.onerror = () => {
            URL.revokeObjectURL(imgUrl);
            reject(new Error('Failed to load image'));
        };

        // KLUCZOWE: Dodaj crossOrigin dla bezpieczeństwa (dla lokalnych plików nie jest konieczne ale nie szkodzi)
        img.crossOrigin = 'anonymous';
        img.src = imgUrl;
    });
}

async function processAllImages(mode = 'zip') {
    if (state.files.length === 0) {
        showToast('Brak plików do przetworzenia', 'warning');
        return;
    }

    // For individual mode, first select folder, then process
    if (mode === 'individual') {
        await processIndividualImages();
        return;
    }

    state.isProcessing = true;
    state.processedFiles = [];

    // Show progress
    elements.progressOverlay.style.display = 'flex';
    elements.btnCancelProcessing.style.display = 'inline-flex';

    const settings = { ...state.settings };
    const total = state.files.length;
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < state.files.length; i++) {
        if (!state.isProcessing) break;

        const fileObj = state.files[i];
        fileObj.status = 'processing';

        try {
            const result = await processImage(fileObj, settings);

            // Store processed data
            fileObj.processedData = result;
            fileObj.status = 'done';

            state.processedFiles.push({
                name: fileObj.newName || fileObj.name.replace(/\.[^.]+$/, '.jpg'),
                blob: result.blob
            });

        } catch (e) {
            console.error('Error processing:', e);
            fileObj.status = 'error';
            errors++;
        }

        processed++;
        const percent = Math.round((processed / total) * 100);

        elements.progressBar.style.width = `${percent}%`;
        elements.progressText.textContent = `${percent}%`;
        elements.progressStatus.textContent = `Przetwarzanie: ${fileObj.name}`;
    }

    state.isProcessing = false;
    elements.progressStatus.textContent = errors > 0
        ? `Zakończono z ${errors} błędami`
        : 'Zakończono pomyślnie';

    elements.btnCancelProcessing.style.display = 'none';

    // Hide progress overlay after a short delay to show completion status
    setTimeout(() => {
        elements.progressOverlay.style.display = 'none';
    }, 1500);

    if (errors === 0) {
        showToast(`Przetworzono ${processed} plików`, 'success');
    } else {
        showToast(`Przetworzono ${processed - errors} z ${processed} plików`, 'warning');
    }

    // KLUCZOWE: Automatyczne pobieranie ZIP dla trybu zip
    if (state.processedFiles.length > 0 && mode === 'zip') {
        // Automatycznie pobierz ZIP zamiast pokazywać przycisk
        await downloadAsZip();
    }
}

// New function for individual mode - select folder first, then process and save
async function processIndividualImages() {
    if (state.files.length === 0) {
        showToast('Brak plików do przetworzenia', 'warning');
        return;
    }

    // Check if File System Access API is available
    if (!('showDirectoryPicker' in window)) {
        showToast('Ta funkcja wymaga przeglądarki obsługującej File System Access API (Chrome, Edge)', 'error');
        return;
    }

    let directoryHandle;
    try {
        // First, select the folder
        directoryHandle = await window.showDirectoryPicker({
            mode: 'readwrite',
            startIn: 'downloads'
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            showToast('Anulowano wybór folderu', 'info');
        } else {
            console.error('Error selecting directory:', error);
            showToast('Błąd podczas wyboru folderu', 'error');
        }
        return;
    }

    // Now start processing with progress
    state.isProcessing = true;
    state.processedFiles = [];

    // Show progress
    elements.progressOverlay.style.display = 'flex';
    elements.btnCancelProcessing.style.display = 'inline-flex';

    const settings = { ...state.settings };
    const total = state.files.length;
    let processed = 0;
    let saved = 0;
    let errors = 0;

    for (let i = 0; i < state.files.length; i++) {
        if (!state.isProcessing) break;

        const fileObj = state.files[i];
        fileObj.status = 'processing';

        try {
            // Process the image
            const result = await processImage(fileObj, settings);

            // Store processed data
            fileObj.processedData = result;
            fileObj.status = 'done';

            state.processedFiles.push({
                name: fileObj.newName || fileObj.name.replace(/\.[^.]+$/, '.jpg'),
                blob: result.blob
            });

            // Save immediately to the selected directory
            const fileName = fileObj.newName || fileObj.name.replace(/\.[^.]+$/, '.jpg');
            const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(result.blob);
            await writable.close();
            saved++;

        } catch (e) {
            console.error('Error processing or saving:', e);
            fileObj.status = 'error';
            errors++;
        }

        processed++;
        const percent = Math.round((processed / total) * 100);

        elements.progressBar.style.width = `${percent}%`;
        elements.progressText.textContent = `${percent}%`;
        elements.progressStatus.textContent = `Przetwarzanie: ${fileObj.name} (${saved}/${total} zapisanych)`;
    }

    state.isProcessing = false;
    elements.progressStatus.textContent = errors > 0
        ? `Zakończono z ${errors} błędami`
        : 'Zakończono pomyślnie';

    elements.btnCancelProcessing.style.display = 'none';

    // Hide progress overlay after a short delay
    setTimeout(() => {
        elements.progressOverlay.style.display = 'none';
    }, 1500);

    if (errors === 0) {
        showToast(`Przetworzono i zapisano ${saved} plików do wybranego folderu`, 'success');
    } else {
        showToast(`Przetworzono ${saved} z ${processed} plików (${errors} błędów)`, 'warning');
    }
}

function cancelProcessing() {
    state.isProcessing = false;
    elements.progressOverlay.style.display = 'none';
    showToast('Przetwarzanie anulowane', 'warning');
}

// ===================================
// ZIP Download
// ===================================

async function downloadAsZip() {
    if (state.processedFiles.length === 0) {
        showToast('Brak przetworzonych plików', 'warning');
        return;
    }

    // Check if JSZip is available
    if (typeof JSZip === 'undefined') {
        showToast('Biblioteka JSZip nie jest dostępna. Pobieranie plików indywidualnie...', 'warning');
        // Fallback: download files individually
        state.processedFiles.forEach((file) => {
            const url = URL.createObjectURL(file.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 100);
        });
        showToast(`Pobrano ${state.processedFiles.length} plików indywidualnie`, 'success');
        return;
    }

    showToast('Tworzenie archiwum ZIP...', 'info');

    try {
        const zip = new JSZip();

        // Add all processed files to ZIP
        state.processedFiles.forEach((file) => {
            zip.file(file.name, file.blob);
        });

        // Generate ZIP file
        const zipBlob = await zip.generateAsync({ type: 'blob' });

        // Download ZIP
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fotopim-processed.zip';
        a.click();
        URL.revokeObjectURL(url);

        showToast(`Archiwum ZIP utworzone pomyślnie! (${state.processedFiles.length} plików)`, 'success');
    } catch (error) {
        console.error('Error creating ZIP:', error);
        showToast('Błąd podczas tworzenia archiwum ZIP', 'error');
    }
}

// ===================================
// Individual Files Download
// ===================================

async function downloadIndividualFiles() {
    if (state.processedFiles.length === 0) {
        showToast('Brak przetworzonych plików', 'warning');
        return;
    }

    // Check if File System Access API is available
    if ('showDirectoryPicker' in window) {
        try {
            // Request directory access
            const directoryHandle = await window.showDirectoryPicker({
                mode: 'readwrite',
                startIn: 'downloads'
            });

            showToast('Zapisywanie plików...', 'info');

            let savedCount = 0;
            let errorsCount = 0;

            // Save each file to the selected directory
            for (const file of state.processedFiles) {
                try {
                    const fileHandle = await directoryHandle.getFileHandle(file.name, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(file.blob);
                    await writable.close();
                    savedCount++;
                } catch (error) {
                    console.error(`Error saving file ${file.name}:`, error);
                    errorsCount++;
                }
            }

            if (errorsCount === 0) {
                showToast(`Zapisano ${savedCount} plików do wybranego folderu`, 'success');
            } else {
                showToast(`Zapisano ${savedCount} plików (${errorsCount} błędów)`, 'warning');
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                showToast('Anulowano wybór folderu', 'info');
            } else {
                console.error('Error accessing directory:', error);
                showToast('Błąd podczas zapisu do folderu', 'error');
            }
        }
    } else {
        // Fallback: download files individually to default download location
        showToast('Przeglądarka nie obsługuje wyboru folderu. Pobieranie plików...', 'info');

        let downloadCount = 0;
        for (const file of state.processedFiles) {
            const url = URL.createObjectURL(file.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 100);
            downloadCount++;
        }

        showToast(`Pobrano ${downloadCount} plików do folderu pobierania`, 'success');
    }
}

// ===================================
// Drag & Drop
// ===================================

function initDragAndDrop() {
    const centerPanel = document.getElementById('centerPanel');

    // Prevent default on document/window for all file drops
    ['dragover', 'drop'].forEach(eventName => {
        document.addEventListener(eventName, e => {
            if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
            }
        });
        window.addEventListener(eventName, e => {
            if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
            }
        }, false);
    });

    // Handle file drops on center panel
    centerPanel.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            handleDrop(e);
        }
    });

    centerPanel.addEventListener('dragover', function (e) {
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });

    elements.fileInput.addEventListener('change', function (e) {
        addFiles(e.target.files);
        e.target.value = '';
    });
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;

    // Check if it's a directory
    if (dt.items) {
        const items = Array.from(dt.items);
        const dirItem = items.find(item => {
            const entry = item.webkitGetAsEntry?.();
            return entry && entry.isDirectory;
        });

        if (dirItem) {
            // Handle directory drop - would need additional logic
            showToast('Upuszczenie folderów wymaga wybrania folderu wejściowego', 'warning');
            return;
        }
    }

    addFiles(files);
}

// ===================================
// Event Listeners
// ===================================

function initEventListeners() {
    // Theme
    elements.themeToggle.addEventListener('click', toggleTheme);

    // Settings changes
    const settingInputs = [
        elements.margin, elements.maxSide, elements.minSize,
        elements.maxMb, elements.baseName, elements.startNumber
    ];

    settingInputs.forEach(input => {
        if (input) {
            input.addEventListener('change', updateSettingsFromUI);
            input.addEventListener('input', updateSettingsFromUI);
        }
    });

    const checkboxes = [elements.useMargin, elements.useMaxSide, elements.useMinSize, elements.useMaxMb];
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', updateSettingsFromUI);
    });

    // Toolbar
    elements.btnClearList.addEventListener('click', clearFiles);
    if (elements.btnDeleteSelected) {
        elements.btnDeleteSelected.addEventListener('click', removeSelectedFiles);
    }

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
        // Only trigger delete if not in an input field
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // More robust Delete key check (Delete, Del for older IE, keyCode 46)
        if ((e.key === 'Delete' || e.key === 'Del' || e.keyCode === 46) && state.selectedFileIds.length > 0) {
            e.preventDefault();
            removeSelectedFiles();
        }
        if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            // Re-implement Select All logic since button is gone but shortcut is useful
            state.selectedFileIds = state.files.map(f => f.id);
            document.querySelectorAll('.file-row').forEach(row => {
                row.classList.add('selected');
            });
            updateSelectionCount();
            if (state.selectedFileIds.length > 0) {
                showPreview(state.selectedFileIds[state.selectedFileIds.length - 1]);
            }
        }
        if (e.key === 'Escape') {
            deselectAllFiles();
        }
    });

    // Preview threshold (individual file or multi-selection)
    elements.thresholdSlider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);

        if (state.selectedFileIds.length > 0) {
            const lastSelectedId = state.selectedFileIds[state.selectedFileIds.length - 1];
            const fileObj = state.files.find(f => f.id === lastSelectedId);
            if (fileObj) {
                fileObj.threshold = value;
                showPreview(lastSelectedId);
            }
        }
    });

    // Processing
    elements.btnStartProcessing.addEventListener('click', () => processAllImages('zip'));
    elements.btnProcessSingle.addEventListener('click', processIndividualImages);
    elements.btnCancelProcessing.addEventListener('click', cancelProcessing);
    elements.btnDownloadZip.addEventListener('click', downloadAsZip);

    // Panel Resizer is initialized in init()
}

// ===================================
// Panel Resizer
// ===================================

function initPanelResizer() {
    const resizer = document.getElementById('panelResizer');
    const rightPanel = document.getElementById('rightPanel');
    const centerPanel = document.getElementById('centerPanel');

    if (!resizer || !rightPanel || !centerPanel) return;

    let isResizing = false;
    let startX = 0;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        resizer.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const totalWidth = centerPanel.offsetWidth + rightPanel.offsetWidth;
        const diff = startX - e.clientX;
        const newWidthPx = rightPanel.offsetWidth + diff;
        const newPct = Math.max(20, Math.min(50, (newWidthPx / totalWidth) * 100));

        // Update flex ratios
        centerPanel.style.flex = (100 - newPct) + '';
        rightPanel.style.flex = newPct + '';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizer.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// ===================================
// Initialization
// ===================================

function init() {
    initTheme();
    initPanelResizer();  // Initialize panel resizer before rendering files
    loadSettings();
    initEventListeners();
    initDragAndDrop();
    renderFiles();
    clearOldSettings();
    updateSelectionCount();
}

function clearOldSettings() {
    const saved = localStorage.getItem('fotopim-settings');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            let needsSave = false;
            if ('baseName' in parsed || 'startNumber' in parsed || 'threshold' in parsed) {
                delete parsed.baseName;
                delete parsed.startNumber;
                delete parsed.threshold;
                needsSave = true;
            }
            if (needsSave) {
                localStorage.setItem('fotopim-settings', JSON.stringify(parsed));
            }
        } catch (e) { }
    }
}

// Start the application
document.addEventListener('DOMContentLoaded', init);
