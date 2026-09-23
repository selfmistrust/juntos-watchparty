/* eslint-disable @typescript-eslint/no-explicit-any */

let loader: Promise<any> | null = null;

/** Carrega a IFrame API uma única vez por página e resolve com window.YT. */
export function loadYoutubeApi(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('ssr'));
  const w = window as any;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (loader) return loader;

  loader = new Promise((resolve) => {
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(w.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    document.head.appendChild(script);
  });

  return loader;
}
