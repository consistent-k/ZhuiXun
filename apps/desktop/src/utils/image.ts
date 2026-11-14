/**
 * 上传前在渲染进程内对图片做降采样 + 重编码，减小上传体积与后续 base64 注入体积。
 * 纯浏览器 Canvas 实现，不引依赖；失败或无收益时回退原文件。
 */

/** 长边像素上限：超过则等比缩放到该尺寸 */
const MAX_DIMENSION = 2000;
/** 小于该体积且尺寸未超限的图片免压，省一次编解码 */
const SKIP_BELOW_BYTES = 1024 * 1024;
/** 有损格式（jpeg/webp）重编码质量 */
const QUALITY = 0.85;

/** 仅对这些类型压缩；gif 可能是动图，canvas 会丢帧，一律跳过 */
function targetType(type: string): 'image/png' | 'image/jpeg' | 'image/webp' | null {
    if (type === 'image/png') return 'image/png';
    if (type === 'image/webp') return 'image/webp';
    if (type === 'image/jpeg' || type === 'image/jpg') return 'image/jpeg';
    return null;
}

/**
 * 压缩单张图片。保持原格式类别（png 保留透明通道，jpeg/webp 有损重编码）。
 *
 * @param file 原始图片 File
 * @returns 压缩后的 File；不适用或没有收益时返回原 File
 */
export async function compressImage(file: File): Promise<File> {
    const type = targetType(file.type);
    if (!type) return file;

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        return file;
    }

    try {
        const { width, height } = bitmap;
        const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
        // 尺寸未超限且体积已足够小：免压
        if (scale === 1 && file.size <= SKIP_BELOW_BYTES) return file;

        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, w, h);

        const quality = type === 'image/png' ? undefined : QUALITY;
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
        // 编码失败或没压小：用原图
        if (!blob || blob.size >= file.size) return file;

        return new File([blob], file.name, { type, lastModified: Date.now() });
    } finally {
        bitmap.close();
    }
}
