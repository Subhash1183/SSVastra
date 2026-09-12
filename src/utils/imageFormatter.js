/**
 * SS VASTRA - Smart Image Formatter & URL Normalizer
 * Handles external image link transformations (Google Drive, Dropbox, Imgur)
 * and provides responsive placeholder fallbacks.
 */

// Premium Luxury SVG Fallback Placeholder (Gold accents on soft warm neutral background)
export const FALLBACK_PLACEHOLDER_IMAGE = 
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 750' width='600' height='750'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23fdfaf5'/%3E%3Cstop offset='100%25' stop-color='%23f4ede0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='100%25' height='100%25' fill='url(%23g)'/%3E%3Crect x='20' y='20' width='560' height='710' fill='none' stroke='%23d4af37' stroke-width='1.5' stroke-dasharray='6 6' rx='12' opacity='0.5'/%3E%3Cg transform='translate(300, 340)' text-anchor='middle'%3E%3Ccircle cx='0' cy='-40' r='42' fill='%23ffffff' stroke='%23d4af37' stroke-width='1.5'/%3E%3Ctext y='-33' font-family='serif' font-size='22' font-weight='bold' fill='%23b38728'%3ESS%3C/text%3E%3Ctext y='45' font-family='sans-serif' font-size='17' font-weight='600' letter-spacing='3' fill='%232c1e0a'%3ESS VASTRA%3C/text%3E%3Ctext y='72' font-family='sans-serif' font-size='12' font-weight='500' letter-spacing='1' fill='%238c734b'%3EIMAGE PREVIEW NOT AVAILABLE%3C/text%3E%3C/g%3E%3C/svg%3E";

// Alias for backwards compatibility across existing components
export const FALLBACK_PRODUCT_IMAGE = FALLBACK_PLACEHOLDER_IMAGE;

/**
 * Normalizes user-provided or external URLs into direct, embeddable image CDN links.
 * Automatically transforms:
 * - Google Drive view links (/file/d/ID/view, open?id=ID) -> direct thumbnail or uc?export=view
 * - Dropbox share links (dl=0) -> raw=1 direct media streams
 * - Imgur page links (imgur.com/ID) -> direct CDN image URLs (i.imgur.com/ID.jpg)
 * - Protocol-relative and naked domains
 *
 * @param {string} rawUrl 
 * @returns {string} Clean direct image URL
 */
export const normalizeImageUrl = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let url = rawUrl.trim();
  if (!url) return "";

  // 1. Keep data URIs, blob URLs, and internal relative paths intact
  if (url.startsWith("data:image/") || url.startsWith("blob:") || url.startsWith("/")) {
    return url;
  }

  // 2. Handle protocol-relative URLs (//example.com/img.jpg)
  if (url.startsWith("//")) {
    url = "https:" + url;
  }

  // 3. Auto-prepend https:// if missing protocol
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  // 4. Google Drive direct link conversion
  // Handles:
  // - https://drive.google.com/file/d/{FILE_ID}/view?usp=sharing
  // - https://drive.google.com/open?id={FILE_ID}
  // - https://drive.google.com/uc?id={FILE_ID}
  if (url.includes("drive.google.com")) {
    const fileIdMatch = 
      url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || 
      url.match(/[?&]id=([a-zA-Z0-9_-]+)/);

    if (fileIdMatch && fileIdMatch[1]) {
      const fileId = fileIdMatch[1];
      // Google Drive thumbnail endpoint is fast, reliable, and bypasses Google's view-page redirect
      return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;
    }
  }

  // 5. Dropbox direct link conversion
  // Replaces ?dl=0 with ?raw=1 to directly stream image bytes
  if (url.includes("dropbox.com")) {
    url = url.replace(/([?&])dl=0/g, "$1raw=1");
    if (!url.includes("raw=1") && !url.includes("dl=1")) {
      url += (url.includes("?") ? "&" : "?") + "raw=1";
    }
    return url;
  }

  // 6. Imgur direct image link conversion
  // Converts imgur.com/xyz to i.imgur.com/xyz.jpg
  if (url.includes("imgur.com") && !url.includes("i.imgur.com")) {
    const imgurMatch = url.match(/imgur\.com\/(?:a\/|gallery\/)?([a-zA-Z0-9]+)(?:[#?].*)?$/);
    if (imgurMatch && imgurMatch[1]) {
      const imgId = imgurMatch[1];
      return `https://i.imgur.com/${imgId}.jpg`;
    }
  }

  return url;
};
