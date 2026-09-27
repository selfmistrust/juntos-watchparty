import {
  GOOGLE_CLOUD_PROJECT_NUMBER,
  GOOGLE_PICKER_API_KEY,
} from '@/lib/driveAccount';

interface PickerDocument {
  id?: string;
}

interface PickerResponse {
  [key: string]: unknown;
}

interface PickerDocsView {
  setMimeTypes(mimeTypes: string): PickerDocsView;
  setIncludeFolders(include: boolean): PickerDocsView;
  /** Mostra apenas estes arquivos. É o que reduz a autorização a um clique. */
  setFileIds(fileIds: string): PickerDocsView;
  setMode(mode: string): PickerDocsView;
}

interface PickerDialog {
  setVisible(visible: boolean): void;
  dispose(): void;
}

interface PickerBuilder {
  setAppId(appId: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  addView(view: PickerDocsView): PickerBuilder;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
  build(): PickerDialog;
}

interface GooglePickerApi {
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  ViewId: { DOCS: string };
  DocsViewMode: { LIST: string; GRID: string };
  DocsView: new (viewId: string) => PickerDocsView;
  PickerBuilder: new () => PickerBuilder;
}

interface GapiApi {
  load(api: string, callback: () => void): void;
}

declare global {
  interface Window {
    gapi?: GapiApi;
    google?: { picker?: GooglePickerApi };
  }
}

let scriptPromise: Promise<void> | null = null;
let pickerPromise: Promise<void> | null = null;

function loadGoogleApiScript(): Promise<void> {
  if (window.gapi) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error('picker_load_failed'));
    }, 15_000);
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.defer = true;
    script.dataset.googleApi = 'true';
    script.onload = () => {
      window.clearTimeout(timeout);
      if (window.gapi) resolve();
      else reject(new Error('picker_load_failed'));
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('picker_load_failed'));
    };
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptPromise = null;
    throw error;
  });

  return scriptPromise;
}

async function loadPickerApi(): Promise<GooglePickerApi> {
  await loadGoogleApiScript();
  if (!pickerPromise) {
    pickerPromise = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('picker_load_failed')), 15_000);
      window.gapi!.load('picker', () => {
        window.clearTimeout(timeout);
        resolve();
      });
    }).catch((error: unknown) => {
      pickerPromise = null;
      throw error;
    });
  }
  await pickerPromise;
  const picker = window.google?.picker;
  if (!picker) throw new Error('picker_load_failed');
  return picker;
}

const VIDEOS = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/mpeg',
  'video/ogg',
  'video/3gpp',
  'video/x-ms-wmv',
].join(',');

/** Abre o seletor oficial para escolher um vídeo; `null` significa cancelamento. */
export async function escolherVideoNoGoogleDrive(accessToken: string, signal?: AbortSignal): Promise<string | null> {
  const pickerApi = await abrirPicker(accessToken, signal);
  if (!pickerApi) return null;
  return mostrar(pickerApi, accessToken, (view) => view.setMimeTypes(VIDEOS).setIncludeFolders(false), signal);
}

/**
 * Abre o seletor já filtrado para **um** arquivo.
 *
 * É o botão "Autorizar este vídeo" de quem está na sala: o Google só dá o
 * vínculo do app com o arquivo quando a pessoa o escolhe, e o `drive.file` não
 * tem como conceder isso sozinho. Mostrar só aquele vídeo transforma o
 * aproveitamento em um clique, em vez de uma caça ao arquivo certo numa lista
 * com todo o Drive.
 *
 * O `LIST` é o que a documentação recomenda sem escopo amplo: o app não tem
 * direito a thumbnails do Drive, e o modo de lista não as pede.
 */
export async function autorizarArquivoDoGoogleDrive(
  accessToken: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{10,256}$/.test(fileId)) return false;
  const pickerApi = await abrirPicker(accessToken, signal);
  if (!pickerApi) return false;
  const escolhido = await mostrar(
    pickerApi,
    accessToken,
    (view) => view.setFileIds(fileId).setMode(pickerApi.DocsViewMode.LIST),
    signal,
  );
  return escolhido === fileId;
}

async function abrirPicker(accessToken: string, signal?: AbortSignal): Promise<GooglePickerApi | null> {
  if (!GOOGLE_PICKER_API_KEY || !GOOGLE_CLOUD_PROJECT_NUMBER) {
    throw new Error('picker_not_configured');
  }
  const pickerApi = await loadPickerApi();
  if (signal?.aborted) return null;
  return pickerApi;
}

/** Monta o diálogo, liga a view e resolve com o id escolhido ou `null`. */
function mostrar(
  pickerApi: GooglePickerApi,
  accessToken: string,
  configurar: (view: PickerDocsView) => PickerDocsView,
  signal?: AbortSignal,
): Promise<string | null> {
  const view = configurar(new pickerApi.DocsView(pickerApi.ViewId.DOCS));
  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    let dialog: PickerDialog | null = null;
    const finish = (fileId: string | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abortar);
      dialog?.dispose();
      resolve(fileId);
    };
    const abortar = () => finish(null);
    signal?.addEventListener('abort', abortar, { once: true });

    try {
      dialog = new pickerApi.PickerBuilder()
        .setAppId(GOOGLE_CLOUD_PROJECT_NUMBER)
        .setOAuthToken(accessToken)
        .setDeveloperKey(GOOGLE_PICKER_API_KEY)
        .setOrigin(window.location.origin)
        .addView(view)
        .setCallback((data) => {
          const action = data[pickerApi.Response.ACTION];
          if (action === pickerApi.Action.CANCEL) {
            finish(null);
            return;
          }
          if (action !== pickerApi.Action.PICKED) return;

          const documents = data[pickerApi.Response.DOCUMENTS] as PickerDocument[] | undefined;
          const fileId = documents?.[0]?.id;
          finish(typeof fileId === 'string' ? fileId : null);
        })
        .build();
      dialog.setVisible(true);
    } catch (error) {
      signal?.removeEventListener('abort', abortar);
      dialog?.dispose();
      reject(error);
    }
  });
}
