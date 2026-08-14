/**
 * @file image-encoding.test.ts
 * @description Unit tests for the client-safe File → base64 helper used to
 * inline chat image attachments for the Gemini vision model (Phase C3).
 */

import { fileToBase64 } from '../image-encoding';

describe('fileToBase64', () => {
  it('strips the data: URI prefix and returns raw base64', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' });
    const b64 = await fileToBase64(file);
    expect(b64).toBe(Buffer.from([1, 2, 3]).toString('base64')); // 'AQID'
    expect(b64).not.toContain(',');
  });

  it('round-trips a larger payload losslessly', async () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i;
    const file = new File([bytes], 'gradient.png', { type: 'image/png' });
    const b64 = await fileToBase64(file);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('rejects when the FileReader errors', async () => {
    const originalFileReader = global.FileReader;
    class FailingFileReader {
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      error = new Error('boom');
      readAsDataURL() {
        this.onerror?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>);
      }
    }
    // @ts-expect-error - stubbing the global for the error path
    global.FileReader = FailingFileReader;
    try {
      const file = new File([new Uint8Array([9])], 'bad.png', { type: 'image/png' });
      await expect(fileToBase64(file)).rejects.toThrow('boom');
    } finally {
      global.FileReader = originalFileReader;
    }
  });
});
