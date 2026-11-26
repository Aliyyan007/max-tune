// Client-side save of server download URLs with real progress + real filenames.
//
//   fetch(GET) → if !ok → parse the server's {error} into a thrown Error
//   (the old <a download> nav saved that JSON as a file — the "track that was
//   actually an error page" bug) → then save by capability:
//
//     File System Access API (Chrome/Edge/Opera/Android 132+) → native save
//       picker → stream straight to disk with per-byte progress. Zero memory.
//     No FS API → accumulate → Blob → a[download] (Firefox/Safari; the blob is
//       complete when it hands off, so the browser DM shows the real size).
//     iOS / navIfNoPicker → plain navigation (browser DM owns it; job-status
//       still mirrors progress in the status bar).
//
// Content-Length from the server gives an EXACT total on flac/mp3 tagger paths
// and every staged file — the progress bar is real, not a spinner.
export interface SaveOpts {
    signal?: AbortSignal;
    navIfNoPicker?: boolean; // zips & iOS: blobbing GBs is fragile — navigate instead
    forceNav?: boolean; // queue artifacts redirect cross-origin to object storage; browser navigation does not need CORS
    onProgress?: (received: number, total: number | null) => void;
    onHeaders?: (headers: Headers) => void;
}

export interface SaveResult {
    bytes: number;
    servedBy: string | null;
    method: 'picker' | 'blob' | 'nav' | 'aborted';
}

const hasPicker = () => typeof window !== 'undefined' && typeof (window as any).showSaveFilePicker === 'function';
const isIOS = () => typeof navigator !== 'undefined' && /iP(ad|hone|od)/.test(navigator.userAgent);

const cdName = (h: Headers): string | null => {
    const cd = h.get('content-disposition') ?? '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    return plain ? plain[1] : null;
};

// Extract a human message from an error Response — server sends {error:"..."}
// JSON (or the HTML error page for navigations, which fetch never triggers).
async function responseError(res: Response): Promise<Error> {
    try {
        const j = await res.clone().json();
        if (j?.error) return new Error(String(j.error));
    } catch {}
    try {
        const t = await res.text();
        const stripped = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (stripped) return new Error(stripped.slice(0, 300));
    } catch {}
    return new Error(`Download failed (HTTP ${res.status})`);
}

export async function saveUrl(url: string, fallbackName: string, opts: SaveOpts = {}): Promise<SaveResult> {
    const none = { bytes: 0, servedBy: null };

    if (opts.forceNav || (opts.navIfNoPicker && (!hasPicker() || isIOS()))) {
        const a = document.createElement('a');
        a.href = url;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return { ...none, method: 'nav' };
    }

    const res = await fetch(url, { signal: opts.signal });
    if (!res.ok || !res.body) throw await responseError(res);

    const total = parseInt(res.headers.get('content-length') ?? '') || null;
    const servedBy = res.headers.get('x-resolved-source');
    const name = cdName(res.headers) ?? fallbackName;
    opts.onHeaders?.(res.headers);

    // Chromium: native save-location picker → stream to disk. Picker opens after
    // headers arrive so suggestedName carries the real extension.
    let writable: any = null;
    if (hasPicker() && !isIOS()) {
        try {
            const fh = await (window as any).showSaveFilePicker({ suggestedName: name });
            writable = await fh.createWritable();
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                // user backed out of the picker — close the fetch so the server
                // sees the disconnect and cleans up the job
                try {
                    await res.body.cancel();
                } catch {}
                return { ...none, method: 'aborted' };
            }
            // SecurityError (gesture expired) → fall through to blob save
        }
    }

    const reader = res.body.getReader();
    let received = 0;
    const chunks: BlobPart[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (writable) await writable.write(value);
        else chunks.push(value);
        opts.onProgress?.(received, total);
    }

    if (writable) {
        await writable.close();
        return { bytes: received, servedBy, method: 'picker' };
    }

    const blob = new Blob(chunks);
    const obj = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = obj;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(obj), 60000);
    return { bytes: received, servedBy, method: 'blob' };
}
