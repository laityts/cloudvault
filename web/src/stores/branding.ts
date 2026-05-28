import type { BrandingData } from '~/api/types';

const DEFAULTS: BrandingData = {
  siteName: 'CloudVault',
  siteIconUrl: '',
};

/** Reads branding data injected by the worker into a <script id="branding-data"> tag. */
export function readBranding(): BrandingData {
  if (typeof document === 'undefined') return DEFAULTS;
  const el = document.getElementById('branding-data');
  if (!el) return DEFAULTS;
  try {
    const parsed = JSON.parse(el.textContent || '{}');
    return { siteName: parsed.siteName || DEFAULTS.siteName, siteIconUrl: parsed.siteIconUrl || '' };
  } catch {
    return DEFAULTS;
  }
}

/** Updates document.title and favicon link based on branding. Safe to call on every change. */
export function applyBrandingToDocument(branding: BrandingData, titleSuffix?: string) {
  if (typeof document === 'undefined') return;
  document.title = titleSuffix ? `${branding.siteName} — ${titleSuffix}` : branding.siteName;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (branding.siteIconUrl) {
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = branding.siteIconUrl;
  } else if (link) {
    link.remove();
  }
}
