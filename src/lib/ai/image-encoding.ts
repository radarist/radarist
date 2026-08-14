/**
 * @file image-encoding.ts
 * @description Client-safe File → base64 for inline chat images. Uses FileReader
 * (available in the browser + jsdom) and strips the `data:<mime>;base64,` prefix
 * so the payload matches the chat API's `images[].data` contract.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
