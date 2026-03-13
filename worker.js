// FotoPIM Web Worker - przetwarzanie obrazów w tle
// Odpowiednik ThreadPoolExecutor z wersji Pythonowej

// ===================================
// Funkcja trimWhitespace (bez zależności od DOM)
// ===================================
function trimWhitespace(imageData, threshold, margin) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    // Target threshold: pixels where at least one channel is darker than (255 - threshold)
    // are considered part of the image (not background)
    const t = 255 - threshold;

    let top = -1, bottom = -1, left = -1, right = -1;

    // Find top
    outerTop:
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            // Check Alpha > 10 AND (RGB is NOT background white)
            if (data[i + 3] > 10 && (data[i] < t || data[i + 1] < t || data[i + 2] < t)) {
                top = y;
                break outerTop;
            }
        }
    }

    // If nothing found, return full image
    if (top === -1) return { left: 0, top: 0, right: width - 1, bottom: height - 1 };

    // Find bottom
    outerBottom:
    for (let y = height - 1; y >= top; y--) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] > 10 && (data[i] < t || data[i + 1] < t || data[i + 2] < t)) {
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
            if (data[i + 3] > 10 && (data[i] < t || data[i + 1] < t || data[i + 2] < t)) {
                left = x;
                break outerLeft;
            }
        }
    }

    // Find right
    outerRight:
    for (let x = width - 1; x >= left; x--) {
        for (let y = top; y <= bottom; y++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] > 10 && (data[i] < t || data[i + 1] < t || data[i + 2] < t)) {
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

// ===================================
// Główna logika workera
// ===================================
self.onmessage = async function(e) {
    const { type, data } = e.data;

    switch (type) {
        case 'GENERATE_THUMBNAIL':
            await handleGenerateThumbnail(data);
            break;

        case 'PROCESS_FILE':
            await handleProcessFile(data);
            break;

        default:
            console.warn('Unknown worker message type:', type);
    }
};

async function handleGenerateThumbnail(fileData) {
    const {
        id,
        fileBuffer,
        fileName,
        fileType,
        threshold,
        margin,
        originalWidth,
        originalHeight
    } = fileData;

    try {
        // KLUCZOWA: Downsample przy dekodowaniu
        const blob = new Blob([fileBuffer], { type: fileType });
        const PREVIEW_MAX_SIZE = 600;
        const maxDim = Math.max(originalWidth, originalHeight);
        const scaleForPreview = maxDim > PREVIEW_MAX_SIZE ? PREVIEW_MAX_SIZE / maxDim : 1;
        const targetWidth = Math.floor(originalWidth * scaleForPreview);
        const targetHeight = Math.floor(originalHeight * scaleForPreview);

        // Dekoduj od razu do małego rozmiaru
        const img = await createImageBitmap(blob, {
            resizeWidth: targetWidth,
            resizeHeight: targetHeight,
            resizeQuality: 'high'
        });

        // Sprawdź czy OffscreenCanvas jest dostępny
        let tempCanvas, tempCtx;
        if (typeof OffscreenCanvas !== 'undefined') {
            tempCanvas = new OffscreenCanvas(img.width, img.height);
            tempCtx = tempCanvas.getContext('2d');
        } else {
            // Fallback - wyślij dane z powrotem do głównego wątku
            img.close();
            self.postMessage({
                type: 'THUMBNAIL_ERROR',
                data: { id, error: 'OffscreenCanvas not supported' }
            });
            return;
        }

        tempCtx.drawImage(img, 0, 0);
        img.close();

        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const bbox = trimWhitespace(imageData, threshold, margin);

        // Scale bbox back to original
        const scaledBbox = {
            left: Math.floor(bbox.left / scaleForPreview),
            top: Math.floor(bbox.top / scaleForPreview),
            right: Math.ceil(bbox.right / scaleForPreview),
            bottom: Math.ceil(bbox.bottom / scaleForPreview)
        };

        const trimmedWidth = scaledBbox.right - scaledBbox.left + 1;
        const trimmedHeight = scaledBbox.bottom - scaledBbox.top + 1;
        const trimmedResolution = `${trimmedWidth}x${trimmedHeight}`;

        // Generate thumbnail
        const size = 150;
        const thumbCanvas = new OffscreenCanvas(size, size);
        const thumbCtx = thumbCanvas.getContext('2d');

        const thumbScale = Math.min(size / (bbox.right - bbox.left + 1), size / (bbox.bottom - bbox.top + 1));
        const w = (bbox.right - bbox.left + 1) * thumbScale;
        const h = (bbox.bottom - bbox.top + 1) * thumbScale;
        const x = (size - w) / 2;
        const y = (size - h) / 2;

        thumbCtx.fillStyle = '#e5e7eb';
        thumbCtx.fillRect(0, 0, size, size);
        thumbCtx.drawImage(
            tempCanvas,
            bbox.left, bbox.top, bbox.right - bbox.left + 1, bbox.bottom - bbox.top + 1,
            x, y, w, h
        );

        const thumbnailBlob = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
        const thumbnailBuffer = await thumbnailBlob.arrayBuffer();

        self.postMessage({
            type: 'THUMBNAIL_READY',
            data: {
                id,
                thumbnailBuffer,
                trimmedResolution,
                bbox: scaledBbox
            }
        }, [thumbnailBuffer]);

    } catch (error) {
        self.postMessage({
            type: 'THUMBNAIL_ERROR',
            data: { id, error: error.message || String(error) }
        });
    }
}

async function handleProcessFile(fileData) {
    const { id, fileBuffer, fileType, params } = fileData;

    try {
        const blob = new Blob([fileBuffer], { type: fileType });
        const img = await createImageBitmap(blob);

        // Processing logic here...
        // (resize, trim, compress, etc.)

        self.postMessage({
            type: 'FILE_PROCESSED',
            data: { id }
        });

    } catch (error) {
        self.postMessage({
            type: 'FILE_ERROR',
            data: { id, error: error.message }
        });
    }
}
