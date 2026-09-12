/**
 * SS VASTRA - Client-Side Cloudinary Image Upload & Storage Service
 * 
 * Direct Browser-to-Cloudinary Unsigned Upload with:
 * - Pre-upload HTML5 Canvas compression (WebP / JPEG @ 1200px max, 0.85 quality)
 * - Zero heavy dependencies (Native fetch, FormData, Canvas API)
 * - Resilient fallback to local compressed Base64 if keys are missing or offline
 * - Returns Cloud CDN HTTPS URL for minimal database document payload
 */

/**
 * Compresses an image File/Blob on the client side using HTML5 Canvas.
 * Converts to WebP (fallback to JPEG), caps max dimension at 1200px, quality 0.85.
 * Returns a compressed File/Blob ready for direct FormData transmission.
 *
 * @param {File|Blob} file 
 * @param {number} maxWidth - Max width/height dimension in px (default 1200)
 * @param {number} quality - Compression quality 0-1 (default 0.85)
 * @returns {Promise<File>}
 */
export const compressBeforeUpload = (file, maxWidth = 1200, quality = 0.85) => {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      return reject(new Error("The selected file is not a valid image."));
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to load and decode image data."));
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        const maxDim = maxWidth || 1200;

        // Calculate aspect ratio preserving bounds
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");

        // High-definition bicubic smoothing for luxury fabrics
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);

        // Attempt modern WebP format
        canvas.toBlob(
          (blob) => {
            if (blob && blob.size > 0) {
              const baseName = (file.name || "product_image").replace(/\.[^/.]+$/, "");
              const compressedFile = new File([blob], `${baseName}.webp`, {
                type: "image/webp",
                lastModified: Date.now()
              });
              resolve(compressedFile);
            } else {
              // Fallback to JPEG if browser does not support WebP canvas blob
              canvas.toBlob(
                (jpegBlob) => {
                  if (jpegBlob && jpegBlob.size > 0) {
                    const baseName = (file.name || "product_image").replace(/\.[^/.]+$/, "");
                    const compressedFile = new File([jpegBlob], `${baseName}.jpg`, {
                      type: "image/jpeg",
                      lastModified: Date.now()
                    });
                    resolve(compressedFile);
                  } else {
                    reject(new Error("Canvas blob compression failed."));
                  }
                },
                "image/jpeg",
                quality
              );
            }
          },
          "image/webp",
          quality
        );
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
};

/**
 * Local canvas compression fallback generating a compact Base64 Data URI.
 * Used when Cloudinary keys are not set or when internet connectivity is offline.
 *
 * @param {File|Blob} file 
 * @param {number} maxWidth 
 * @param {number} quality 
 * @returns {Promise<string>} Base64 Data URL
 */
export const convertToBase64 = (file, maxWidth = 1200, quality = 0.85) => {
  return new Promise((resolve) => {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      resolve("");
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => resolve("");
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => resolve(event.target?.result || "");
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        const maxDim = maxWidth || 1200;

        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);

        let compressedUri = canvas.toDataURL("image/webp", quality);
        if (!compressedUri.startsWith("data:image/webp")) {
          compressedUri = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(compressedUri);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
};

/**
 * Sends a compressed image directly to Cloudinary's Unsigned Upload REST API endpoint.
 * Requires VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET in .env.
 *
 * @param {File|Blob} file 
 * @param {string} folder - Optional destination folder in Cloudinary
 * @returns {Promise<string>} The HTTPS CDN secure_url
 */
export const uploadToCloudinary = async (file, folder = "ss_vastra_products") => {
  const cloudName = (import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || "").trim();
  const uploadPreset = (import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || "").trim();

  if (!cloudName || !uploadPreset || cloudName.includes("your_cloudinary")) {
    throw new Error("Missing or placeholder Cloudinary configuration in .env");
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", uploadPreset);
  if (folder) {
    formData.append("folder", folder);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    body: formData
  });

  const data = await response.json();

  if (!response.ok || !data.secure_url) {
    // If the unsigned preset disallows dynamic folder params, retry once without folder
    if (folder && data?.error?.message?.toLowerCase().includes("folder")) {
      const retryFormData = new FormData();
      retryFormData.append("file", file);
      retryFormData.append("upload_preset", uploadPreset);
      const retryResp = await fetch(endpoint, {
        method: "POST",
        body: retryFormData
      });
      const retryData = await retryResp.json();
      if (retryResp.ok && retryData.secure_url) {
        return retryData.secure_url;
      }
    }
    const errorMsg = data?.error?.message || `HTTP ${response.status}: Cloudinary upload failed`;
    throw new Error(errorMsg);
  }

  return data.secure_url;
};

/**
 * Main exported orchestrator function.
 * Coordinates pre-upload canvas compression, Cloudinary upload, and resilient local fallback.
 * 
 * @param {File|Blob} file 
 * @param {Object} [options]
 * @param {string} [options.folder="ss_vastra_products"]
 * @param {number} [options.maxWidth=1200]
 * @param {number} [options.quality=0.85]
 * @returns {Promise<{ url: string, isCloud: boolean, fallback: boolean, error?: string, toString: () => string }>}
 */
export const uploadProductPhotoToCloud = async (file, options = {}) => {
  const {
    folder = "ss_vastra_products",
    maxWidth = 1200,
    quality = 0.85
  } = options;

  const cloudName = (import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || "").trim();
  const uploadPreset = (import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || "").trim();

  const isConfigured = Boolean(
    cloudName &&
    uploadPreset &&
    !cloudName.includes("your_cloudinary") &&
    !uploadPreset.includes("your_unsigned")
  );

  // Fallback if environment variables are not yet configured
  if (!isConfigured) {
    console.info("[ImageUpload] Cloudinary unconfigured. Using local compressed Base64 fallback.");
    const base64 = await convertToBase64(file, maxWidth, quality);
    return {
      url: base64,
      isCloud: false,
      fallback: true,
      toString() { return this.url; }
    };
  }

  // Pre-upload canvas compression + Cloudinary direct upload
  try {
    const compressedBlob = await compressBeforeUpload(file, maxWidth, quality);
    const secureUrl = await uploadToCloudinary(compressedBlob, folder);
    return {
      url: secureUrl,
      isCloud: true,
      fallback: false,
      toString() { return this.url; }
    };
  } catch (err) {
    console.warn("[ImageUpload] Cloudinary upload failed. Falling back to local Base64:", err.message);
    const base64 = await convertToBase64(file, maxWidth, quality);
    return {
      url: base64,
      isCloud: false,
      fallback: true,
      error: err.message,
      toString() { return this.url; }
    };
  }
};
