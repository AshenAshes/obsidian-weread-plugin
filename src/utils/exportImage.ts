/** Use image signatures because imported covers often report application/octet-stream. */
export function imageDataUrl(buffer: ArrayBuffer): string {
 const bytes = new Uint8Array(buffer);
 let mime: string;
 if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
 else if ([137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) mime = 'image/png';
 else if (String.fromCharCode(...bytes.subarray(0,6)).match(/^GIF8[79]a$/)) mime = 'image/gif';
 else if (String.fromCharCode(...bytes.subarray(0,4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8,12)) === 'WEBP') mime = 'image/webp';
 else throw new Error('封面不是支持的图片格式');
 const chunks: string[] = [];
 for (let offset = 0; offset < bytes.length; offset += 8192) {
  chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
 }
 return `data:${mime};base64,${btoa(chunks.join(''))}`;
}

export const EXPORT_IMAGE_PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

export function exportErrorMessage(error: unknown): string {
 if (error instanceof Error) return error.message;
 if (typeof error === 'string' && error) return error;
 return '图片加载或生成失败，请重试';
}
