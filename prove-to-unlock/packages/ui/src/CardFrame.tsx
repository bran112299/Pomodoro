import { useEffect, useRef } from "preact/hooks";
import type { MediaFile } from "@ptu/core";

const BASE_CSS = `
html,body{margin:0;padding:0;background:transparent}
body{font:20px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e8e8ef;padding:12px;text-align:center;word-wrap:break-word}
img{max-width:100%;height:auto}
.cloze{font-weight:bold;color:#7aa2ff}
hr#answer{border:0;border-top:1px solid #444;margin:16px 0}
details.hint summary{cursor:pointer;color:#9aa}
`;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Replace references to deck media files with data: URLs. */
export function inlineMedia(html: string, media: Record<string, MediaFile>): string {
  const url = (name: string): string | undefined => {
    let f = media[name];
    if (!f) {
      try {
        f = media[decodeURIComponent(name)];
      } catch {
        /* ignore malformed escapes */
      }
    }
    return f ? `data:${f.mime};base64,${f.data}` : undefined;
  };
  return html
    .replace(/(\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (all, pre: string, q: string, name: string) => {
      const u = url(name);
      return u ? `${pre}${q}${escapeAttr(u)}${q}` : all;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q: string, name: string) => {
      const u = url(name);
      return u ? `url(${q}${u}${q})` : all;
    });
}

/**
 * Renders card HTML in a sandboxed iframe: card scripts never run (no allow-scripts), deck CSS
 * can't leak into the app, and media is inlined.
 */
export function CardFrame(props: { html: string; css?: string; media?: Record<string, MediaFile>; minHeight?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style><style>${props.css ?? ""}</style></head><body class="card">${inlineMedia(props.html, props.media ?? {})}</body></html>`;

  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    const fit = () => {
      const h = f.contentDocument?.documentElement.scrollHeight;
      if (h) f.style.height = `${Math.max(props.minHeight ?? 80, h + 4)}px`;
    };
    f.addEventListener("load", fit);
    const t = setInterval(fit, 500); // images may load late
    return () => {
      f.removeEventListener("load", fit);
      clearInterval(t);
    };
  }, [doc]);

  return <iframe ref={ref} class="ptu-card" sandbox="allow-same-origin" srcdoc={doc} title="card" />;
}
