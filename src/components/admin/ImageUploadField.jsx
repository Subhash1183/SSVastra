import React, { useState, useRef } from "react";
import { Upload, Image as ImageIcon, Trash2, Plus, Loader2, Cloud, HardDrive, CheckCircle2, AlertTriangle } from "lucide-react";
import { uploadProductPhotoToCloud } from "../../services/imageUpload";
import { normalizeImageUrl, FALLBACK_PLACEHOLDER_IMAGE } from "../../utils/imageFormatter";

/**
 * SS VASTRA - Production Image Upload & URL Management Component
 * Supports direct device uploads via HTML5 Canvas compression to Cloudinary CDN,
 * with fallback to local Base64, and manual image URL pasting with auto-normalization.
 *
 * @param {Object} props
 * @param {string[]} props.images - Array of image URLs or data URIs
 * @param {Function} props.onChange - Handler called with updated images array
 * @param {Function} [props.showToast] - Optional toast notifier (msg, type)
 * @param {string} [props.folder="ss_vastra_products"] - Cloudinary destination folder
 */
export default function ImageUploadField({
  images = [],
  onChange,
  showToast,
  folder = "ss_vastra_products"
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  const notify = (msg, type = "info") => {
    if (showToast) {
      showToast(msg, type);
    } else {
      console.log(`[${type.toUpperCase()}] ${msg}`);
    }
  };

  // Process files: Canvas compression -> Cloudinary CDN / Local fallback
  const processFiles = async (files) => {
    const validFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (validFiles.length === 0) {
      notify("Please select valid image files (JPEG, PNG, WEBP, etc.)", "warning");
      return;
    }

    setIsUploading(true);
    setUploadProgress({ current: 0, total: validFiles.length });
    notify(`Processing & compressing ${validFiles.length} image(s)...`, "info");

    const uploadedUrls = [];
    let cloudSuccessCount = 0;
    let fallbackCount = 0;

    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      setUploadProgress({ current: i + 1, total: validFiles.length });

      try {
        const result = await uploadProductPhotoToCloud(file, { folder });
        if (result && result.url) {
          uploadedUrls.push(result.url);
          if (result.isCloud) {
            cloudSuccessCount++;
          } else {
            fallbackCount++;
          }
        }
      } catch (err) {
        console.error("Upload error for file:", file.name, err);
      }
    }

    setIsUploading(false);
    setUploadProgress({ current: 0, total: 0 });

    if (uploadedUrls.length > 0) {
      const existingClean = (images || []).filter((u) => u && u.trim() !== "");
      const newImagesList = [...existingClean, ...uploadedUrls];
      onChange(newImagesList);

      if (cloudSuccessCount > 0 && fallbackCount === 0) {
        notify(`Successfully uploaded ${cloudSuccessCount} photo(s) to Cloud CDN!`, "success");
      } else if (fallbackCount > 0 && cloudSuccessCount === 0) {
        notify(`Saved ${fallbackCount} photo(s) with local compression (Cloudinary unconfigured/offline)`, "warning");
      } else {
        notify(`Uploaded ${uploadedUrls.length} photo(s) (${cloudSuccessCount} Cloud CDN, ${fallbackCount} Local Fallback)`, "success");
      }
    } else {
      notify("Failed to process image(s). Please try again.", "error");
    }
  };

  const handleFileInputChange = async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(e.target.files);
      e.target.value = "";
    }
  };

  // Drag & drop handlers
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFiles(e.dataTransfer.files);
    }
  };

  // Manual URL manipulation
  const handleUrlChange = (index, value) => {
    const updated = [...(images || [])];
    updated[index] = normalizeImageUrl(value);
    onChange(updated);
  };

  const handleRemoveImage = (index) => {
    const updated = (images || []).filter((_, i) => i !== index);
    onChange(updated.length > 0 ? updated : [""]);
  };

  const handleAddUrlField = () => {
    onChange([...(images || []), ""]);
  };

  const isCloudUrl = (url) => typeof url === "string" && (url.includes("cloudinary.com") || url.includes("res.cloudinary.com"));
  const isBase64 = (url) => typeof url === "string" && url.startsWith("data:image/");

  const displayList = images && images.length > 0 ? images : [""];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Top action bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
        <span style={{ fontSize: "0.92rem", fontWeight: 700, color: "var(--accent-gold-light)", display: "flex", alignItems: "center", gap: "8px" }}>
          <ImageIcon size={16} />
          <span>Product Photos & Cloudinary CDN</span>
        </span>

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            onClick={handleAddUrlField}
            className="btn btn-secondary btn-sm"
            style={{ fontSize: "0.75rem", padding: "5px 10px" }}
            title="Add web link field"
          >
            <Plus size={13} />
            <span>Add URL</span>
          </button>

          <button
            type="button"
            disabled={isUploading}
            onClick={() => fileInputRef.current?.click()}
            className="btn btn-primary btn-sm"
            style={{
              fontSize: "0.75rem",
              padding: "5px 12px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              cursor: isUploading ? "not-allowed" : "pointer"
            }}
          >
            {isUploading ? (
              <>
                <Loader2 size={13} className="spin-animation" />
                <span>Uploading {uploadProgress.current}/{uploadProgress.total}...</span>
              </>
            ) : (
              <>
                <Upload size={13} />
                <span>Upload From Device</span>
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileInputChange}
            style={{ display: "none" }}
          />
        </div>
      </div>

      {/* Drag & Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: isDragging ? "2px dashed var(--accent-gold)" : "1.5px dashed var(--border-subtle)",
          background: isDragging ? "rgba(212, 175, 55, 0.08)" : "var(--bg-card)",
          borderRadius: "var(--radius-md)",
          padding: "20px 16px",
          textAlign: "center",
          cursor: "pointer",
          transition: "all 0.2s ease"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
          <div style={{
            width: "40px",
            height: "40px",
            borderRadius: "50%",
            background: "rgba(212, 175, 55, 0.12)",
            color: "var(--accent-gold)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}>
            <Cloud size={20} />
          </div>
          <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
            {isUploading ? "Compressing & Uploading Photos to Cloud..." : "Drag & drop photos here, or click to browse"}
          </div>
          <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>
            Auto-compressed via HTML5 Canvas (WebP 1200px) • Zero backend required
          </div>
        </div>
      </div>

      {/* Image list & input rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {displayList.map((imgUrl, idx) => {
          const cloud = isCloudUrl(imgUrl);
          const base64 = isBase64(imgUrl);
          const normalized = normalizeImageUrl(imgUrl);

          return (
            <div
              key={idx}
              style={{
                display: "flex",
                gap: "10px",
                alignItems: "center",
                background: "var(--bg-card)",
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-subtle)"
              }}
            >
              {/* Image Preview Thumbnail */}
              <div
                style={{
                  position: "relative",
                  width: "48px",
                  height: "48px",
                  flexShrink: 0,
                  borderRadius: "var(--radius-xs)",
                  overflow: "hidden",
                  border: "1px solid var(--border-gold)",
                  background: "#f8f5ee"
                }}
              >
                {normalized ? (
                  <img
                    src={normalized}
                    alt={`Preview ${idx + 1}`}
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      e.currentTarget.src = FALLBACK_PLACEHOLDER_IMAGE;
                    }}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--text-muted)"
                    }}
                  >
                    <ImageIcon size={18} />
                  </div>
                )}
              </div>

              {/* URL or Badge Input */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="url"
                    placeholder="Paste image URL (Cloudinary, Drive, Imgur, Unsplash...)"
                    value={imgUrl}
                    onChange={(e) => handleUrlChange(idx, e.target.value)}
                    className="input-field"
                    style={{ flex: 1, fontSize: "0.82rem", padding: "6px 10px" }}
                  />
                  {cloud && (
                    <span
                      title="Stored on Cloudinary CDN"
                      style={{
                        fontSize: "0.68rem",
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: "12px",
                        background: "rgba(16, 185, 129, 0.15)",
                        color: "#10b981",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        whiteSpace: "nowrap"
                      }}
                    >
                      <Cloud size={11} /> Cloud CDN
                    </span>
                  )}
                  {base64 && (
                    <span
                      title="Locally compressed Base64 fallback"
                      style={{
                        fontSize: "0.68rem",
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: "12px",
                        background: "rgba(245, 158, 11, 0.15)",
                        color: "#f59e0b",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        whiteSpace: "nowrap"
                      }}
                    >
                      <HardDrive size={11} /> Local Fallback
                    </span>
                  )}
                </div>
              </div>

              {/* Remove button */}
              {displayList.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleRemoveImage(idx)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    padding: "6px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center"
                  }}
                  title="Remove image"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
