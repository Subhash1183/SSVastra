import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { INITIAL_PRODUCTS, INITIAL_ORDERS, INITIAL_SETTINGS, INITIAL_COUPONS } from "../data/initialData";
import { generateOrderId, getTotalStock, normalizeImageUrl, FALLBACK_PRODUCT_IMAGE } from "../utils/formatters";
import { playOrderChime } from "../utils/audio";
import confetti from "canvas-confetti";
import { 
  isFirebaseConfigured, 
  fetchStoreVersion,
  updateStoreVersionMeta,
  fetchCloudCatalog, 
  saveCatalogBundleToCloud,
  fetchCloudProducts, 
  saveAllProductsToCloud,
  fetchCloudOrders, 
  fetchOrderByIdFromCloud,
  saveOrderToCloud, 
  updateOrderStatusInCloud,
  deleteOrderFromCloud,
  fetchCloudSettings,
  saveSettingsToCloud
} from "../services/firebase";
import { sendOrderToGoogleSheets } from "../services/googleSheets";

const DEMO_ORDER_IDS = new Set([
  "VAN-4204",
  "VAN-9081",
  "VAN-8021",
  "VAN-7945",
  "VAN-7415",
  "VAN-9079",
  "VAN-5319",
  "VAN-8001",
  "VAN-1001",
  "VAN-1002",
  "VAN-1003"
]);

const StoreContext = createContext();

export const STORAGE_KEYS = {
  PRODUCTS: "ss_vastra_clothing_products_v3",
  ORDERS: "ss_vastra_clothing_orders_v3",
  SETTINGS: "ss_vastra_clothing_settings_v3",
  CART: "ss_vastra_clothing_cart_v3",
  WISHLIST: "ss_vastra_clothing_wishlist_v3",
  COUPONS: "ss_vastra_clothing_coupons_v3",
  DELETED_PRODUCT_IDS: "ss_vastra_clothing_deleted_prod_ids_v3",
  STORE_VERSION: "STORE_VERSION",
  ORDERS_VERSION: "ORDERS_VERSION",
  SETTINGS_VERSION: "SETTINGS_VERSION"
};

// Module-level in-memory timestamp throttling window (2.5 minutes)
const THROTTLE_WINDOW_MS = 150000;
let lastVersionCheckTimestamp = 0;
let lastOrdersSyncTimestamp = 0;

const getDeletedProductIds = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.DELETED_PRODUCT_IDS);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
};

const addDeletedProductId = (id) => {
  if (!id) return;
  try {
    const current = getDeletedProductIds();
    if (!current.includes(id)) {
      const updated = [...current, id];
      localStorage.setItem(STORAGE_KEYS.DELETED_PRODUCT_IDS, JSON.stringify(updated));
    }
  } catch {
    // ignore
  }
};

const removeDeletedProductId = (id) => {
  if (!id) return;
  try {
    const current = getDeletedProductIds();
    const updated = current.filter((x) => x !== id);
    localStorage.setItem(STORAGE_KEYS.DELETED_PRODUCT_IDS, JSON.stringify(updated));
  } catch {
    // ignore
  }
};

export const normalizeOrder = (order) => {
  if (!order || typeof order !== "object") return null;

  // 1. Calculate items and total safely
  let items = Array.isArray(order.items) ? order.items : [];
  let subtotal = Number(order.subtotal) || 0;
  let shippingFee = Number(order.shippingFee) || 0;
  let total = Number(order.total) || 0;

  // Check if this matches a known initial order ID (or if it was corrupted to 0 items and 0 total)
  const initialMatch = INITIAL_ORDERS.find((init) => init.id === order.id);
  if (initialMatch && (items.length === 0 || total === 0)) {
    items = initialMatch.items;
    subtotal = initialMatch.subtotal;
    shippingFee = initialMatch.shippingFee;
    total = initialMatch.total;
  }

  // If items exist, calculate accurate subtotal and total
  if (items.length > 0) {
    const calcSubtotal = items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1), 0);
    if (subtotal === 0) subtotal = calcSubtotal;
    if (total === 0) total = subtotal + shippingFee;
  } else if (total === 0) {
    // If an order has 0 items and 0 total, repair it with a catalog product
    const fallbackProd = INITIAL_PRODUCTS[0];
    items = [
      {
        productId: fallbackProd.id,
        name: fallbackProd.name,
        image: fallbackProd.images[0],
        size: "M",
        color: fallbackProd.colors[0]?.name || "Standard",
        price: fallbackProd.price,
        quantity: 1
      }
    ];
    subtotal = fallbackProd.price;
    shippingFee = 0;
    total = fallbackProd.price;
  }

  const custName = order.customer?.fullName && order.customer.fullName !== "Valued Customer" && order.customer.fullName !== "Customer"
    ? order.customer.fullName
    : (initialMatch ? initialMatch.customer.fullName : (order.fullName || "Customer"));

  const custPhone = order.customer?.phone || (initialMatch ? initialMatch.customer.phone : (order.phone || ""));
  const custEmail = order.customer?.email || (initialMatch ? initialMatch.customer.email : (order.email || ""));
  const custAddress = order.customer?.address || (initialMatch ? initialMatch.customer.address : (order.address || "Direct Order via WhatsApp"));
  const custCity = order.customer?.city && order.customer.city !== "India"
    ? order.customer.city
    : (initialMatch ? initialMatch.customer.city : (order.city || "Jaipur"));
  const custState = order.customer?.state || (initialMatch ? initialMatch.customer.state : (order.state || "Rajasthan"));
  const custPincode = order.customer?.pincode || (initialMatch ? initialMatch.customer.pincode : (order.pincode || "302001"));
  const custNotes = order.customer?.notes || (initialMatch ? initialMatch.customer.notes : (order.notes || ""));

  return {
    ...order,
    id: order.id || generateOrderId("SSV"),
    createdAt: order.createdAt || new Date().toISOString(),
    updatedAt: order.updatedAt || order.createdAt || new Date().toISOString(),
    status: order.status || "New",
    customer: {
      fullName: custName,
      phone: custPhone,
      email: custEmail,
      address: custAddress,
      city: custCity,
      state: custState,
      pincode: custPincode,
      notes: custNotes
    },
    items,
    subtotal,
    shippingFee,
    total,
    paymentMethod: order.paymentMethod || "Prepaid (UPI)",
    dispatchInfo: {
      courierPartner: order.dispatchInfo?.courierPartner || "",
      trackingNumber: order.dispatchInfo?.trackingNumber || "",
      dispatchDate: order.dispatchInfo?.dispatchDate || "",
      notes: order.dispatchInfo?.notes || ""
    }
  };
};

export const StoreProvider = ({ children }) => {
  // 1. Core State with LocalStorage initialization
  const [products, setProducts] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.PRODUCTS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
      const deletedIds = getDeletedProductIds();
      return INITIAL_PRODUCTS.filter((p) => p && !deletedIds.includes(p.id));
    } catch {
      return INITIAL_PRODUCTS;
    }
  });

  const [orders, setOrders] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.ORDERS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const cleaned = parsed
            .filter((o) => o && o.id && !DEMO_ORDER_IDS.has(o.id))
            .map(normalizeOrder)
            .filter(Boolean);
          return cleaned;
        }
      }
      return INITIAL_ORDERS.filter((o) => o && !DEMO_ORDER_IDS.has(o.id)).map(normalizeOrder).filter(Boolean);
    } catch {
      return INITIAL_ORDERS.filter((o) => o && !DEMO_ORDER_IDS.has(o.id)).map(normalizeOrder).filter(Boolean);
    }
  });

  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (!parsed.brandName || parsed.brandName.toUpperCase().includes("VANSHRA")) {
          localStorage.removeItem(STORAGE_KEYS.SETTINGS);
          return INITIAL_SETTINGS;
        }

        const handle = parsed.instagramHandle || "@ss_vastra";

        return {
          ...INITIAL_SETTINGS,
          ...parsed,
          brandName: "SS VASTRA",
          tagline: (parsed.tagline && !parsed.tagline.includes("Crafted for Comfort")) ? parsed.tagline : INITIAL_SETTINGS.tagline,
          logoUrl: "/ss-vastra-logo.png",
          googleSheetWebhookUrl: parsed.googleSheetWebhookUrl || INITIAL_SETTINGS.googleSheetWebhookUrl,
          instagramHandle: handle,
          instagramQrUrl: parsed.instagramQrUrl || "/ss-vastra-logo.png",
          hero: {
            ...INITIAL_SETTINGS.hero,
            ...(parsed.hero || {})
          }
        };
      }
      return INITIAL_SETTINGS;
    } catch {
      return INITIAL_SETTINGS;
    }
  });

  const [cart, setCart] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CART);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [wishlist, setWishlist] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.WISHLIST);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [coupons, setCoupons] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.COUPONS);
      return saved ? JSON.parse(saved) : INITIAL_COUPONS;
    } catch {
      return INITIAL_COUPONS;
    }
  });

  const [appliedCoupon, setAppliedCoupon] = useState(null);

  // Admin PIN Authentication & Privacy
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(() => {
    return sessionStorage.getItem("ss_vastra_admin_auth") === "true";
  });
  const [isAdminAuthModalOpen, setIsAdminAuthModalOpen] = useState(false);

  // 2. Navigation & UI state
  const [currentView, setCurrentView] = useState("store"); // "store" | "admin"
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [selectedOrderForDetail, setSelectedOrderForDetail] = useState(null);
  const [latestPlacedOrder, setLatestPlacedOrder] = useState(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isQuickViewOpen, setIsQuickViewOpen] = useState(false);
  const [quickViewProduct, setQuickViewProduct] = useState(null);
  const [isSizeGuideOpen, setIsSizeGuideOpen] = useState(false);
  const [isOrderTrackingOpen, setIsOrderTrackingOpen] = useState(false);
  const [adminTab, setAdminTab] = useState("overview"); // "overview" | "orders" | "products" | "settings"

  // 3. Storefront Filters & Search
  const [activeCategory, setActiveCategory] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [sizeFilter, setSizeFilter] = useState("All");
  const [sortBy, setSortBy] = useState("featured"); // "featured" | "newest" | "price-low" | "price-high"
  const [priceRange, setPriceRange] = useState(10000);

  // 4. Notifications & Toasts
  const [toasts, setToasts] = useState([]);

  const showToast = (message, type = "info", duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  };

  const removeToast = (id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Safe LocalStorage setter with QuotaExceededError protection & auto-pruning
  const safeSetStorage = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn(`LocalStorage quota exceeded for key: ${key}. Attempting storage optimization...`, e);
      try {
        if (key === STORAGE_KEYS.ORDERS && Array.isArray(value)) {
          const trimmed = value.slice(0, 30);
          localStorage.setItem(key, JSON.stringify(trimmed));
        } else if (key === STORAGE_KEYS.PRODUCTS && Array.isArray(value)) {
          const trimmed = value.map((p) => ({
            ...p,
            images: (p.images || []).slice(0, 2)
          }));
          localStorage.setItem(key, JSON.stringify(trimmed));
        }
      } catch (innerErr) {
        console.warn("Storage write fallback failed.", innerErr);
      }
    }
  };

  // Comprehensive Centralized SPA Navigation Helpers
  const navigateToHome = () => {
    setCurrentView("store");
    setSelectedProductId(null);
    setIsCartOpen(false);
    setIsCheckoutOpen(false);
    setIsQuickViewOpen(false);
    setIsSizeGuideOpen(false);
    setIsOrderTrackingOpen(false);
    setIsAdminAuthModalOpen(false);
    setSelectedOrderForDetail(null);
    setSearchQuery("");

    if (window.location.hash) {
      window.history.pushState(null, "", window.location.pathname);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const navigateToProduct = (productId) => {
    setCurrentView("store");
    setSelectedProductId(productId);
    setIsCartOpen(false);
    setIsCheckoutOpen(false);
    setIsQuickViewOpen(false);
    setIsSizeGuideOpen(false);
    setIsOrderTrackingOpen(false);
    setSelectedOrderForDetail(null);

    const targetHash = `#product-${productId}`;
    if (window.location.hash !== targetHash) {
      window.history.pushState({ modal: "product", id: productId }, "", targetHash);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const navigateToCategory = (categoryName) => {
    setCurrentView("store");
    setSelectedProductId(null);
    setActiveCategory(categoryName);
    setIsCartOpen(false);
    setIsCheckoutOpen(false);
    setIsQuickViewOpen(false);
    setIsSizeGuideOpen(false);
    setIsOrderTrackingOpen(false);
    setSelectedOrderForDetail(null);

    if (window.location.hash) {
      window.history.pushState(null, "", window.location.pathname);
    }

    setTimeout(() => {
      const catalogEl = document.getElementById("catalog-section");
      if (catalogEl) {
        catalogEl.scrollIntoView({ behavior: "smooth" });
      }
    }, 100);
  };

  const navigateToAdmin = () => {
    if (isAdminAuthenticated) {
      setCurrentView("admin");
      if (window.location.hash !== "#admin") {
        window.history.pushState({ modal: "admin" }, "", "#admin");
      }
      syncAdminOrders(false);
    } else {
      setIsAdminAuthModalOpen(true);
    }
  };

  // Dedicated Modal Opener and Closer Helpers
  const openCart = () => {
    setIsCartOpen(true);
    if (window.location.hash !== "#cart") {
      window.history.pushState({ modal: "cart" }, "", "#cart");
    }
  };

  const closeCart = () => {
    setIsCartOpen(false);
    if (window.location.hash === "#cart") {
      window.history.pushState(null, "", window.location.pathname + (selectedProductId ? `#product-${selectedProductId}` : ""));
    }
  };

  const openCheckout = () => {
    setIsCheckoutOpen(true);
    if (window.location.hash !== "#checkout") {
      window.history.pushState({ modal: "checkout" }, "", "#checkout");
    }
  };

  const closeCheckout = () => {
    setIsCheckoutOpen(false);
    if (window.location.hash === "#checkout") {
      window.history.pushState(null, "", window.location.pathname + (selectedProductId ? `#product-${selectedProductId}` : ""));
    }
  };

  const openQuickView = (product) => {
    setQuickViewProduct(product);
    setIsQuickViewOpen(true);
    if (window.location.hash !== "#quickview") {
      window.history.pushState({ modal: "quickview" }, "", "#quickview");
    }
  };

  const closeQuickView = () => {
    setIsQuickViewOpen(false);
    setQuickViewProduct(null);
    if (window.location.hash === "#quickview") {
      window.history.pushState(null, "", window.location.pathname + (selectedProductId ? `#product-${selectedProductId}` : ""));
    }
  };

  const openSizeGuide = () => {
    setIsSizeGuideOpen(true);
    if (window.location.hash !== "#sizeguide") {
      window.history.pushState({ modal: "sizeguide" }, "", "#sizeguide");
    }
  };

  const closeSizeGuide = () => {
    setIsSizeGuideOpen(false);
    if (window.location.hash === "#sizeguide") {
      window.history.pushState(null, "", window.location.pathname + (selectedProductId ? `#product-${selectedProductId}` : ""));
    }
  };

  const openOrderTracking = () => {
    setIsOrderTrackingOpen(true);
    if (window.location.hash !== "#tracking") {
      window.history.pushState({ modal: "tracking" }, "", "#tracking");
    }
  };

  const closeOrderTracking = () => {
    setIsOrderTrackingOpen(false);
    if (window.location.hash === "#tracking") {
      window.history.pushState(null, "", window.location.pathname + (selectedProductId ? `#product-${selectedProductId}` : ""));
    }
  };

  const closeAdminAuth = () => {
    setIsAdminAuthModalOpen(false);
    if (window.location.hash === "#admin" && !isAdminAuthenticated) {
      window.history.pushState(null, "", window.location.pathname);
    }
  };

  // Synchronize Browser History / Hash on Navigation
  useEffect(() => {
    const handlePopState = () => {
      const hash = window.location.hash;
      if (hash.startsWith("#product-")) {
        const prodId = hash.replace("#product-", "");
        setSelectedProductId(prodId);
        setIsCartOpen(false);
        setIsCheckoutOpen(false);
        setIsQuickViewOpen(false);
        setIsSizeGuideOpen(false);
        setIsOrderTrackingOpen(false);
        setIsAdminAuthModalOpen(false);
      } else if (hash === "#admin") {
        if (sessionStorage.getItem("ss_vastra_admin_auth") === "true") {
          setIsAdminAuthenticated(true);
          setCurrentView("admin");
        } else {
          setIsAdminAuthModalOpen(true);
        }
      } else if (hash === "#cart") {
        setIsCartOpen(true);
      } else if (hash === "#checkout") {
        setIsCheckoutOpen(true);
      } else if (hash === "#quickview") {
        setIsQuickViewOpen(true);
      } else if (hash === "#sizeguide") {
        setIsSizeGuideOpen(true);
      } else if (hash === "#tracking") {
        setIsOrderTrackingOpen(true);
      } else {
        if (isCartOpen) closeCart();
        else if (isCheckoutOpen) closeCheckout();
        else if (isQuickViewOpen) closeQuickView();
        else if (isSizeGuideOpen) closeSizeGuide();
        else if (isOrderTrackingOpen) closeOrderTracking();
        else if (isAdminAuthModalOpen) closeAdminAuth();
        else if (selectedProductId) setSelectedProductId(null);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [
    isCartOpen,
    isCheckoutOpen,
    isQuickViewOpen,
    isSizeGuideOpen,
    isOrderTrackingOpen,
    isAdminAuthModalOpen,
    selectedProductId,
    isAdminAuthenticated
  ]);

  // Initial deep link / hash check on page load
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#product-")) {
      const prodId = hash.replace("#product-", "");
      setSelectedProductId(prodId);
    } else if (hash === "#admin") {
      if (sessionStorage.getItem("ss_vastra_admin_auth") === "true") {
        setIsAdminAuthenticated(true);
        setCurrentView("admin");
      } else {
        setIsAdminAuthModalOpen(true);
      }
    } else if (hash === "#tracking") {
      setIsOrderTrackingOpen(true);
    } else if (hash === "#cart") {
      setIsCartOpen(true);
    }
  }, []);

  // Sync state to LocalStorage with quota protection
  useEffect(() => {
    safeSetStorage(STORAGE_KEYS.PRODUCTS, products);
  }, [products]);

  useEffect(() => {
    safeSetStorage(STORAGE_KEYS.ORDERS, orders);
  }, [orders]);

  useEffect(() => {
    safeSetStorage(STORAGE_KEYS.SETTINGS, settings);
  }, [settings]);

  useEffect(() => {
    safeSetStorage(STORAGE_KEYS.CART, cart);
  }, [cart]);

  useEffect(() => {
    safeSetStorage(STORAGE_KEYS.WISHLIST, wishlist);
  }, [wishlist]);

  useEffect(() => {
    safeSetStorage(STORAGE_KEYS.COUPONS, coupons);
  }, [coupons]);

  // Multi-tab real-time synchronization
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (!e.newValue) return;
      try {
        if (e.key === STORAGE_KEYS.SETTINGS) {
          const parsed = JSON.parse(e.newValue);
          setSettings({
            ...INITIAL_SETTINGS,
            ...parsed,
            hero: { ...INITIAL_SETTINGS.hero, ...(parsed.hero || {}) }
          });
        } else if (e.key === STORAGE_KEYS.PRODUCTS) {
          setProducts(JSON.parse(e.newValue));
        } else if (e.key === STORAGE_KEYS.ORDERS) {
          const parsed = JSON.parse(e.newValue);
          if (Array.isArray(parsed)) {
            setOrders(parsed.map(normalizeOrder).filter(Boolean));
          }
        } else if (e.key === STORAGE_KEYS.COUPONS) {
          const parsed = JSON.parse(e.newValue);
          if (Array.isArray(parsed)) {
            setCoupons(parsed);
          }
        }
      } catch (err) {
        console.warn("Storage sync listener error", err);
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // Dynamic Browser Tab / Document Title
  useEffect(() => {
    const title = settings.brandName
      ? `${settings.brandName} | ${settings.tagline || "Ladies Fashion & Fabrics - Elegance in Every Thread"}`
      : "SS VASTRA | Ladies Fashion & Fabrics - Elegance in Every Thread";
    document.title = title;
  }, [settings.brandName, settings.tagline]);

  // ==========================================
  // Optimized Cloud Database Sync Engine (Patterns #1, #2, #3, #4)
  // ==========================================

  // Synchronize Storefront Data with Version-Based Caching (0–1 Read for Returning Visitors)
  const syncWithCloud = async (force = false) => {
    if (!isFirebaseConfigured()) return;
    const now = Date.now();
    
    // In-Memory Session Throttling: reuse cache within 2.5 minutes unless forced
    if (!force && now - lastVersionCheckTimestamp < THROTTLE_WINDOW_MS) {
      return;
    }
    lastVersionCheckTimestamp = now;

    try {
      // Step 1: Version Check (Cost: Exactly 1 Firestore Read)
      const versionMeta = await fetchStoreVersion();
      if (!versionMeta) return;

      const localStoreVersion = localStorage.getItem(STORAGE_KEYS.STORE_VERSION) || localStorage.getItem("STORE_VERSION");
      const localSettingsVersion = localStorage.getItem(STORAGE_KEYS.SETTINGS_VERSION) || localStorage.getItem("SETTINGS_VERSION");

      const currentProductsSaved = localStorage.getItem(STORAGE_KEYS.PRODUCTS);
      const hasLocalProducts = Boolean(currentProductsSaved && currentProductsSaved !== "[]");
      
      // Compare version meta: If matched and local products exist, 0 catalog reads!
      const shouldFetchCatalog = force || !hasLocalProducts || (versionMeta.productsUpdatedAt && versionMeta.productsUpdatedAt !== localStoreVersion);
      const shouldFetchSettings = force || (versionMeta.settingsUpdatedAt && versionMeta.settingsUpdatedAt !== localSettingsVersion);

      const fetchPromises = [];
      if (shouldFetchCatalog) {
        fetchPromises.push(fetchCloudCatalog());
      } else {
        fetchPromises.push(Promise.resolve(null));
      }

      if (shouldFetchSettings) {
        fetchPromises.push(fetchCloudSettings());
      } else {
        fetchPromises.push(Promise.resolve(null));
      }

      const [cloudProducts, cloudSettings] = await Promise.all(fetchPromises);

      // Update Catalog if fetched
      if (cloudProducts && Array.isArray(cloudProducts) && cloudProducts.length > 0) {
        setProducts((prev) => {
          if (JSON.stringify(prev) === JSON.stringify(cloudProducts)) return prev;
          safeSetStorage(STORAGE_KEYS.PRODUCTS, cloudProducts);
          return cloudProducts;
        });
        if (versionMeta.productsUpdatedAt) {
          localStorage.setItem(STORAGE_KEYS.STORE_VERSION, versionMeta.productsUpdatedAt);
          localStorage.setItem("STORE_VERSION", versionMeta.productsUpdatedAt);
        }
      }

      // Update Settings if fetched
      if (cloudSettings && Object.keys(cloudSettings).length > 0) {
        setSettings((prev) => {
          const merged = { ...prev, ...cloudSettings };
          if (JSON.stringify(prev) === JSON.stringify(merged)) return prev;
          safeSetStorage(STORAGE_KEYS.SETTINGS, merged);
          return merged;
        });
        if (versionMeta.settingsUpdatedAt) {
          localStorage.setItem(STORAGE_KEYS.SETTINGS_VERSION, versionMeta.settingsUpdatedAt);
          localStorage.setItem("SETTINGS_VERSION", versionMeta.settingsUpdatedAt);
        }
      }

      // If Admin is currently active, sync orders with versioning
      if (isAdminAuthenticated || currentView === "admin") {
        await syncAdminOrders(force, versionMeta);
      }
    } catch (err) {
      console.warn("[SS VASTRA Cloud Sync]", err);
    }
  };

  // Synchronize Admin Orders (Pattern #4: 98% Order Read Reduction)
  const syncAdminOrders = async (force = false, existingVersionMeta = null) => {
    if (!isFirebaseConfigured()) return;
    const now = Date.now();

    if (!force && now - lastOrdersSyncTimestamp < THROTTLE_WINDOW_MS) {
      return;
    }
    lastOrdersSyncTimestamp = now;

    try {
      const versionMeta = existingVersionMeta || await fetchStoreVersion();
      const localOrdersVersion = localStorage.getItem(STORAGE_KEYS.ORDERS_VERSION) || localStorage.getItem("ORDERS_VERSION");
      const currentOrdersSaved = localStorage.getItem(STORAGE_KEYS.ORDERS);
      const hasLocalOrders = Boolean(currentOrdersSaved && currentOrdersSaved !== "[]");

      const shouldFetchOrders = force || !hasLocalOrders || (versionMeta?.ordersUpdatedAt && versionMeta.ordersUpdatedAt !== localOrdersVersion);

      if (!shouldFetchOrders) {
        // 0 Reads: Orders haven't changed in cloud, render instantly from localStorage!
        return;
      }

      // Fetch capped recent orders (pageSize=30)
      const cloudOrders = await fetchCloudOrders(30);
      if (cloudOrders && Array.isArray(cloudOrders)) {
        const normalizedCloud = cloudOrders
          .filter((o) => o && o.id && !DEMO_ORDER_IDS.has(o.id))
          .map(normalizeOrder)
          .filter(Boolean);

        setOrders((prev) => {
          const prevMap = new Map(prev.map((o) => [o.id, o]));
          const resolvedOrders = normalizedCloud.map((cloudOrd) => {
            const localOrd = prevMap.get(cloudOrd.id);
            if (!localOrd) return cloudOrd;

            const localTime = new Date(localOrd.updatedAt || localOrd.createdAt || 0).getTime();
            const cloudTime = new Date(cloudOrd.updatedAt || cloudOrd.createdAt || 0).getTime();

            if (localTime > cloudTime) {
              return localOrd;
            }
            return cloudOrd;
          });

          // Preserve any existing local orders outside recent 30-item window
          const cloudIdSet = new Set(normalizedCloud.map((o) => o.id));
          prev.forEach((localOrd) => {
            if (!cloudIdSet.has(localOrd.id) && !DEMO_ORDER_IDS.has(localOrd.id)) {
              resolvedOrders.push(localOrd);
            }
          });

          const sorted = resolvedOrders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

          if (JSON.stringify(prev) === JSON.stringify(sorted)) return prev;
          safeSetStorage(STORAGE_KEYS.ORDERS, sorted);
          return sorted;
        });

        setSelectedOrderForDetail((curr) => {
          if (!curr) return null;
          const match = normalizedCloud.find((o) => o.id === curr.id);
          if (!match) return curr;
          const currTime = new Date(curr.updatedAt || curr.createdAt || 0).getTime();
          const matchTime = new Date(match.updatedAt || match.createdAt || 0).getTime();
          return currTime > matchTime ? curr : match;
        });

        if (versionMeta?.ordersUpdatedAt) {
          localStorage.setItem(STORAGE_KEYS.ORDERS_VERSION, versionMeta.ordersUpdatedAt);
          localStorage.setItem("ORDERS_VERSION", versionMeta.ordersUpdatedAt);
        }
      }
    } catch (err) {
      console.warn("[SS VASTRA Cloud Orders Sync]", err);
    }
  };

  // Initial Mount & Visibility/Focus Sync
  useEffect(() => {
    if (!isFirebaseConfigured()) return;

    // 1. Initial version check on mount
    syncWithCloud(false);

    // 2. Poll interval for active visible tab (throttled to 2.5 minutes)
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        syncWithCloud(false);
      }
    }, THROTTLE_WINDOW_MS);

    // 3. Tab focus / visibility change
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncWithCloud(false);
      }
    };
    const handleFocus = () => syncWithCloud(false);

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Sync Admin Orders whenever Admin panel is active
  useEffect(() => {
    if (isAdminAuthenticated || currentView === "admin") {
      syncAdminOrders(false);
    }
  }, [currentView, adminTab, isAdminAuthenticated]);

  // ==========================================
  // Streamlined Single-Source Writes (Pattern #5)
  // ==========================================

  const addProduct = (productData) => {
    const cleanedImages = Array.isArray(productData.images)
      ? productData.images.map(normalizeImageUrl).filter(Boolean)
      : [];

    const newProduct = {
      ...productData,
      id: `prod-${Date.now()}`,
      images: cleanedImages.length > 0 ? cleanedImages : [FALLBACK_PRODUCT_IMAGE],
      createdAt: new Date().toISOString()
    };

    removeDeletedProductId(newProduct.id);

    setProducts((prev) => {
      const next = [newProduct, ...prev];
      safeSetStorage(STORAGE_KEYS.PRODUCTS, next);
      if (isFirebaseConfigured()) {
        saveCatalogBundleToCloud(next);
      }
      return next;
    });
    showToast(`Product "${newProduct.name}" created successfully!`, "success");
    return newProduct;
  };

  const updateProduct = (productId, updatedFields) => {
    let fields = { ...updatedFields };
    if (Array.isArray(fields.images)) {
      const cleaned = fields.images.map(normalizeImageUrl).filter(Boolean);
      fields.images = cleaned.length > 0 ? cleaned : [FALLBACK_PRODUCT_IMAGE];
    }

    setProducts((prev) => {
      const next = prev.map((prod) => (prod.id === productId ? { ...prod, ...fields } : prod));
      safeSetStorage(STORAGE_KEYS.PRODUCTS, next);
      if (isFirebaseConfigured()) {
        saveCatalogBundleToCloud(next);
      }
      return next;
    });
    showToast("Product updated successfully!", "success");
  };

  const deleteProduct = (productId) => {
    addDeletedProductId(productId);
    setProducts((prev) => {
      const next = prev.filter((prod) => prod.id !== productId);
      safeSetStorage(STORAGE_KEYS.PRODUCTS, next);
      if (isFirebaseConfigured()) {
        saveCatalogBundleToCloud(next);
      }
      return next;
    });
    showToast("Product removed from catalog", "info");
  };

  const updateSizeStock = (productId, sizeKey, newCount) => {
    const count = Math.max(0, parseInt(newCount, 10) || 0);
    setProducts((prev) => {
      const next = prev.map((prod) => {
        if (prod.id === productId) {
          return {
            ...prod,
            sizes: {
              ...prod.sizes,
              [sizeKey]: count
            }
          };
        }
        return prod;
      });
      safeSetStorage(STORAGE_KEYS.PRODUCTS, next);
      if (isFirebaseConfigured()) {
        saveCatalogBundleToCloud(next);
      }
      return next;
    });
    showToast(`Updated ${sizeKey} stock to ${count}`, "success");
  };

  const addCategory = (newCat) => {
    const trimmed = newCat.trim();
    if (!trimmed || settings.categories.includes(trimmed)) return;
    setSettings((prev) => {
      const updated = {
        ...prev,
        categories: [...prev.categories, trimmed]
      };
      safeSetStorage(STORAGE_KEYS.SETTINGS, updated);
      if (isFirebaseConfigured()) {
        saveSettingsToCloud(updated);
      }
      return updated;
    });
    showToast(`Category "${trimmed}" added`, "success");
  };

  const deleteCategory = (catToDelete) => {
    if (catToDelete === "All") return;
    setSettings((prev) => {
      const updated = {
        ...prev,
        categories: prev.categories.filter((c) => c !== catToDelete)
      };
      safeSetStorage(STORAGE_KEYS.SETTINGS, updated);
      if (isFirebaseConfigured()) {
        saveSettingsToCloud(updated);
      }
      return updated;
    });
    if (activeCategory === catToDelete) {
      setActiveCategory("All");
    }
    showToast(`Category "${catToDelete}" removed`, "info");
  };

  // ==================== CART & WISHLIST ACTIONS ====================

  const addToCart = (product, size, color, quantity = 1) => {
    if (!size) {
      showToast("Please select a size first", "warning");
      return false;
    }

    const availableStock = product.sizes?.[size] ?? 0;
    if (availableStock <= 0) {
      showToast(`Size ${size} is currently out of stock!`, "error");
      return false;
    }

    const cartItemId = `${product.id}-${size}-${color?.name || "default"}`;
    const existingIndex = cart.findIndex((item) => item.id === cartItemId);

    if (existingIndex > -1) {
      const currentQty = cart[existingIndex].quantity;
      if (currentQty + quantity > availableStock) {
        showToast(`Only ${availableStock} items in size ${size} available in stock`, "warning");
        return false;
      }
      setCart((prev) =>
        prev.map((item, idx) =>
          idx === existingIndex ? { ...item, quantity: item.quantity + quantity } : item
        )
      );
    } else {
      const newItem = {
        id: cartItemId,
        productId: product.id,
        name: product.name,
        image: product.images?.[0] || "",
        price: product.price,
        size,
        color: color?.name || "Default",
        colorHex: color?.hex || "#000",
        quantity: Math.min(quantity, availableStock),
        maxStock: availableStock
      };
      setCart((prev) => [...prev, newItem]);
    }

    showToast(`Added ${product.name} (${size}) to your bag!`, "success");
    setIsCartOpen(true);
    return true;
  };

  const updateCartQuantity = (cartItemId, newQty) => {
    if (newQty <= 0) {
      removeFromCart(cartItemId);
      return;
    }

    setCart((prev) =>
      prev.map((item) => {
        if (item.id === cartItemId) {
          const product = products.find((p) => p.id === item.productId);
          const maxStock = product?.sizes?.[item.size] ?? 99;
          const clampedQty = Math.min(newQty, maxStock);
          return { ...item, quantity: clampedQty };
        }
        return item;
      })
    );
  };

  const removeFromCart = (cartItemId) => {
    setCart((prev) => prev.filter((item) => item.id !== cartItemId));
    showToast("Item removed from bag", "info");
  };

  const clearCart = () => {
    setCart([]);
  };

  const toggleWishlist = (productId) => {
    setWishlist((prev) => {
      const exists = prev.includes(productId);
      if (exists) {
        showToast("Removed from wishlist", "info");
        return prev.filter((id) => id !== productId);
      } else {
        showToast("Saved to wishlist!", "success");
        return [...prev, productId];
      }
    });
  };

  // Cart & Coupon calculations
  const cartSubtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const couponDiscount = appliedCoupon
    ? (() => {
        if (cartSubtotal < (appliedCoupon.minOrder || 0)) return 0;
        if (appliedCoupon.discountType === "percentage") {
          const calc = Math.round((cartSubtotal * appliedCoupon.value) / 100);
          return appliedCoupon.maxDiscount ? Math.min(calc, appliedCoupon.maxDiscount) : calc;
        }
        return Math.min(appliedCoupon.value, cartSubtotal);
      })()
    : 0;

  useEffect(() => {
    if (appliedCoupon && cartSubtotal > 0 && cartSubtotal < (appliedCoupon.minOrder || 0)) {
      showToast(`Coupon "${appliedCoupon.code}" removed: Minimum order of ₹${appliedCoupon.minOrder} required`, "warning");
      setAppliedCoupon(null);
    } else if (appliedCoupon && cartSubtotal === 0) {
      setAppliedCoupon(null);
    }
  }, [cartSubtotal, appliedCoupon]);

  const isFreeShipping = (cartSubtotal - couponDiscount) >= settings.freeShippingThreshold || cartSubtotal === 0;
  const shippingFee = isFreeShipping ? 0 : settings.standardShippingFee;
  const cartTotal = Math.max(0, cartSubtotal - couponDiscount) + shippingFee;
  const totalCartItemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  // ==================== COUPON ACTIONS ====================

  const applyCoupon = (code) => {
    if (!code || typeof code !== "string") {
      showToast("Please enter a coupon code", "warning");
      return { success: false, message: "Please enter a coupon code" };
    }
    const trimmed = code.trim().toUpperCase();
    const found = coupons.find((c) => c.code.toUpperCase() === trimmed && c.isActive !== false);

    if (!found) {
      showToast(`Coupon code "${trimmed}" is invalid or expired`, "error");
      return { success: false, message: `Coupon code "${trimmed}" is invalid or expired` };
    }

    if (cartSubtotal < (found.minOrder || 0)) {
      showToast(`Coupon "${trimmed}" requires a minimum order of ₹${found.minOrder}`, "warning");
      return { success: false, message: `Minimum order of ₹${found.minOrder} required for this coupon` };
    }

    let discountVal = 0;
    if (found.discountType === "percentage") {
      discountVal = Math.round((cartSubtotal * found.value) / 100);
      if (found.maxDiscount) {
        discountVal = Math.min(discountVal, found.maxDiscount);
      }
    } else {
      discountVal = Math.min(found.value, cartSubtotal);
    }

    setAppliedCoupon(found);
    try {
      confetti({ particleCount: 60, spread: 60, origin: { y: 0.7 } });
    } catch {}
    showToast(`🎉 Coupon "${found.code}" applied! You saved ₹${discountVal}`, "success");
    return { success: true, coupon: found, discount: discountVal };
  };

  const removeCoupon = () => {
    if (appliedCoupon) {
      showToast(`Coupon "${appliedCoupon.code}" removed`, "info");
      setAppliedCoupon(null);
    }
  };

  const addCoupon = (couponData) => {
    const newCode = (couponData.code || "").trim().toUpperCase();
    if (!newCode) {
      showToast("Coupon code cannot be empty", "error");
      return false;
    }
    if (coupons.some((c) => c.code.toUpperCase() === newCode)) {
      showToast(`Coupon code "${newCode}" already exists`, "error");
      return false;
    }
    const newCoupon = {
      id: `cpn-${Date.now()}`,
      code: newCode,
      discountType: couponData.discountType || "percentage",
      value: Number(couponData.value) || 0,
      minOrder: Number(couponData.minOrder) || 0,
      maxDiscount: Number(couponData.maxDiscount) || 0,
      isActive: couponData.isActive !== false,
      description: couponData.description || ""
    };
    setCoupons((prev) => [newCoupon, ...prev]);
    showToast(`Coupon "${newCode}" added successfully!`, "success");
    return newCoupon;
  };

  const updateCoupon = (couponId, fields) => {
    setCoupons((prev) =>
      prev.map((c) => {
        if (c.id === couponId) {
          const updated = { ...c, ...fields };
          if (fields.code) updated.code = fields.code.trim().toUpperCase();
          if (fields.value !== undefined) updated.value = Number(fields.value) || 0;
          if (fields.minOrder !== undefined) updated.minOrder = Number(fields.minOrder) || 0;
          if (fields.maxDiscount !== undefined) updated.maxDiscount = Number(fields.maxDiscount) || 0;
          return updated;
        }
        return c;
      })
    );
    showToast("Coupon updated successfully!", "success");
    return true;
  };

  const deleteCoupon = (couponId) => {
    setCoupons((prev) => prev.filter((c) => c.id !== couponId));
    if (appliedCoupon?.id === couponId) {
      setAppliedCoupon(null);
    }
    showToast("Coupon removed", "info");
  };

  const toggleCouponStatus = (couponId) => {
    setCoupons((prev) =>
      prev.map((c) => {
        if (c.id === couponId) {
          const nextStatus = !c.isActive;
          showToast(`Coupon "${c.code}" is now ${nextStatus ? "Active" : "Inactive"}`, "info");
          return { ...c, isActive: nextStatus };
        }
        return c;
      })
    );
  };

  // ==================== ORDER ACTIONS (2 Writes per Order) ====================

  const placeOrder = (customerData) => {
    if (cart.length === 0) {
      showToast("Your bag is empty", "error");
      return null;
    }

    const orderId = customerData.orderId || generateOrderId("SSV");

    const newOrder = {
      id: orderId,
      createdAt: new Date().toISOString(),
      status: customerData.status || "New",
      paymentMethod: customerData.paymentMethod || "Prepaid (UPI via Razorpay)",
      razorpayPaymentId: customerData.razorpayPaymentId || "",
      razorpayOrderId: customerData.razorpayOrderId || "",
      customer: {
        fullName: customerData.fullName,
        phone: customerData.phone,
        email: customerData.email,
        address: customerData.address,
        city: customerData.city,
        state: customerData.state,
        pincode: customerData.pincode,
        notes: customerData.notes || ""
      },
      items: cart.map((item) => ({
        productId: item.productId,
        name: item.name,
        image: item.image,
        size: item.size,
        color: item.color,
        price: item.price,
        quantity: item.quantity
      })),
      subtotal: cartSubtotal,
      couponCode: appliedCoupon?.code || "",
      couponDiscount: couponDiscount || 0,
      shippingFee,
      total: cartTotal,
      dispatchInfo: {
        courierPartner: "",
        trackingNumber: "",
        dispatchDate: "",
        notes: ""
      }
    };

    // 1. Decrement stock in catalog bundle (Write #1)
    setProducts((prevProducts) => {
      const nextProducts = prevProducts.map((prod) => {
        const orderItems = cart.filter((item) => item.productId === prod.id);
        if (orderItems.length > 0) {
          const nextSizes = { ...(prod.sizes || {}) };
          orderItems.forEach((orderItem) => {
            const currentSizeStock = nextSizes[orderItem.size] ?? 0;
            nextSizes[orderItem.size] = Math.max(0, currentSizeStock - orderItem.quantity);
          });
          return {
            ...prod,
            sizes: nextSizes
          };
        }
        return prod;
      });

      safeSetStorage(STORAGE_KEYS.PRODUCTS, nextProducts);
      if (isFirebaseConfigured()) {
        saveCatalogBundleToCloud(nextProducts);
      }
      return nextProducts;
    });

    // 2. Save order to cloud and storage (Write #2)
    const updatedOrder = normalizeOrder(newOrder);
    setOrders((prev) => {
      const nextOrders = [updatedOrder, ...prev.filter((o) => o.id !== updatedOrder.id)];
      safeSetStorage(STORAGE_KEYS.ORDERS, nextOrders);
      return nextOrders;
    });

    if (isFirebaseConfigured()) {
      saveOrderToCloud(updatedOrder);
    }

    // 3. Dispatch order to Google Sheets & Trigger Automatic Emails
    sendOrderToGoogleSheets(updatedOrder, settings);

    // 4. Clear cart, reset coupon and set latest order for success screen
    clearCart();
    setAppliedCoupon(null);
    setLatestPlacedOrder(newOrder);
    setIsCheckoutOpen(false);
    setIsCartOpen(false);

    // 5. Play audio chime and trigger celebration
    playOrderChime();
    try {
      confetti({
        particleCount: 120,
        spread: 70,
        origin: { y: 0.6 }
      });
    } catch {
      // ignore
    }

    showToast(`Order #${orderId} placed successfully!`, "success", 6000);
    return newOrder;
  };

  const updateOrderStatus = async (orderId, newStatus, dispatchData = {}) => {
    const nowIso = new Date().toISOString();
    let updatedOrderObj = null;

    setOrders((prev) => {
      const next = prev.map((order) => {
        if (order.id === orderId) {
          updatedOrderObj = normalizeOrder({
            ...order,
            status: newStatus,
            updatedAt: nowIso,
            dispatchInfo: {
              ...(order.dispatchInfo || {}),
              ...dispatchData
            }
          });
          return updatedOrderObj;
        }
        return order;
      });
      safeSetStorage(STORAGE_KEYS.ORDERS, next);
      return next;
    });

    if (updatedOrderObj) {
      setSelectedOrderForDetail((prev) => (prev && prev.id === orderId ? updatedOrderObj : prev));

      if (isFirebaseConfigured()) {
        try {
          await updateOrderStatusInCloud(orderId, newStatus, nowIso);
        } catch (err) {
          console.warn("[SS VASTRA Cloud] updateOrderStatus error:", err);
        }
      }
    }
    showToast(`Order #${orderId} marked as ${newStatus}`, "success");
    return updatedOrderObj;
  };

  const deleteOrder = (orderId) => {
    setOrders((prev) => {
      const next = prev.filter((o) => o.id !== orderId);
      safeSetStorage(STORAGE_KEYS.ORDERS, next);
      return next;
    });
    if (isFirebaseConfigured()) {
      deleteOrderFromCloud(orderId);
    }
    if (selectedOrderForDetail?.id === orderId) {
      setSelectedOrderForDetail(null);
    }
    showToast(`Order #${orderId} removed`, "info");
  };

  const clearAllOrders = () => {
    orders.forEach((o) => {
      if (isFirebaseConfigured() && o.id) {
        deleteOrderFromCloud(o.id);
      }
    });
    setOrders([]);
    safeSetStorage(STORAGE_KEYS.ORDERS, []);
    if (selectedOrderForDetail) {
      setSelectedOrderForDetail(null);
    }
    showToast("All customer orders cleared", "info");
  };

  const authenticateAdmin = (enteredPin) => {
    const validPin = String(settings.adminPin || "1234").trim();
    if (String(enteredPin).trim() === validPin) {
      setIsAdminAuthenticated(true);
      sessionStorage.setItem("ss_vastra_admin_auth", "true");
      setIsAdminAuthModalOpen(false);
      setCurrentView("admin");
      if (window.location.hash !== "#admin") {
        window.history.pushState({ modal: "admin" }, "", "#admin");
      }
      syncAdminOrders(false);
      return true;
    }
    return false;
  };

  const logoutAdmin = () => {
    setIsAdminAuthenticated(false);
    sessionStorage.removeItem("ss_vastra_admin_auth");
    setCurrentView("store");
    if (window.location.hash === "#admin") {
      window.history.replaceState(null, "", window.location.pathname);
    }
    showToast("Admin Portal locked successfully", "info");
  };

  const updateAdminPin = (newPin) => {
    const cleanPin = String(newPin).trim();
    if (!cleanPin || cleanPin.length < 4) {
      showToast("PIN must be at least 4 digits", "error");
      return false;
    }
    setSettings((prev) => {
      const updated = { ...prev, adminPin: cleanPin };
      safeSetStorage(STORAGE_KEYS.SETTINGS, updated);
      if (isFirebaseConfigured()) {
        saveSettingsToCloud(updated);
      }
      return updated;
    });
    showToast("Owner security PIN updated successfully!", "success");
    return true;
  };

  const openAdminLogin = () => {
    if (isAdminAuthenticated) {
      setCurrentView("admin");
      syncAdminOrders(false);
    } else {
      setIsAdminAuthModalOpen(true);
    }
  };

  const updateSettings = (newSettings) => {
    setSettings((prev) => {
      const merged = { ...prev, ...newSettings };
      safeSetStorage(STORAGE_KEYS.SETTINGS, merged);
      if (isFirebaseConfigured()) {
        saveSettingsToCloud(merged);
      }
      return merged;
    });
    showToast("Store settings saved successfully!", "success");
  };

  // ==================== BACKUP & RESTORE ====================

  const exportStoreData = () => {
    const data = {
      brand: settings.brandName,
      exportedAt: new Date().toISOString(),
      products,
      orders,
      settings
    };
    const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data, null, 2))}`;
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", jsonString);
    downloadAnchor.setAttribute("download", `${settings.brandName.toLowerCase()}_store_backup_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast("Store data exported as JSON backup!", "success");
  };

  const importStoreData = (jsonData) => {
    try {
      if (jsonData.products && Array.isArray(jsonData.products)) {
        setProducts(jsonData.products);
        if (isFirebaseConfigured()) {
          saveCatalogBundleToCloud(jsonData.products);
        }
      }
      if (jsonData.orders && Array.isArray(jsonData.orders)) {
        setOrders(jsonData.orders);
      }
      if (jsonData.settings && typeof jsonData.settings === "object") {
        setSettings(jsonData.settings);
        if (isFirebaseConfigured()) {
          saveSettingsToCloud(jsonData.settings);
        }
      }
      showToast("Store data successfully imported & restored!", "success");
      return true;
    } catch (err) {
      showToast("Failed to parse backup JSON file", "error");
      return false;
    }
  };

  const resetToDemoData = () => {
    try {
      localStorage.removeItem(STORAGE_KEYS.DELETED_PRODUCT_IDS);
      localStorage.removeItem(STORAGE_KEYS.STORE_VERSION);
      localStorage.removeItem("STORE_VERSION");
      localStorage.removeItem(STORAGE_KEYS.ORDERS_VERSION);
      localStorage.removeItem("ORDERS_VERSION");
    } catch {}
    setProducts(INITIAL_PRODUCTS);
    safeSetStorage(STORAGE_KEYS.PRODUCTS, INITIAL_PRODUCTS);
    if (isFirebaseConfigured()) {
      saveCatalogBundleToCloud(INITIAL_PRODUCTS);
    }
    setOrders(INITIAL_ORDERS);
    safeSetStorage(STORAGE_KEYS.ORDERS, INITIAL_ORDERS);
    setSettings(INITIAL_SETTINGS);
    safeSetStorage(STORAGE_KEYS.SETTINGS, INITIAL_SETTINGS);
    setCart([]);
    showToast("Reset store to official demo catalog & sample orders!", "info");
  };

  // Computed metrics for Admin Dashboard
  const confirmedList = orders.filter((o) => ["Confirmed", "Dispatched", "Delivered"].includes(o.status));
  const metrics = {
    totalRevenue: confirmedList.reduce((sum, o) => sum + (Number(o.total) || 0), 0),
    confirmedUnitsSold: confirmedList.reduce((sum, o) => sum + (o.items?.reduce((iSum, i) => iSum + (Number(i.quantity) || 1), 0) || 0), 0),
    confirmedOrdersCount: confirmedList.length,
    pipelineRevenue: orders.filter((o) => o.status === "New").reduce((sum, o) => sum + (Number(o.total) || 0), 0),
    totalOrders: orders.length,
    newOrdersCount: orders.filter((o) => o.status === "New").length,
    confirmedCount: orders.filter((o) => o.status === "Confirmed").length,
    dispatchedCount: orders.filter((o) => o.status === "Dispatched").length,
    deliveredCount: orders.filter((o) => o.status === "Delivered").length,
    lowStockProducts: products.filter((p) => {
      const total = getTotalStock(p.sizes);
      return total > 0 && total <= 5;
    }),
    outOfStockProducts: products.filter((p) => getTotalStock(p.sizes) === 0)
  };

  return (
    <StoreContext.Provider
      value={{
        // Data
        products,
        orders,
        settings,
        cart,
        wishlist,
        metrics,
        // Views & Modals & Navigation
        currentView,
        setCurrentView,
        navigateToHome,
        navigateToProduct,
        navigateToCategory,
        navigateToAdmin,
        openCart,
        closeCart,
        openCheckout,
        closeCheckout,
        openQuickView,
        closeQuickView,
        openSizeGuide,
        closeSizeGuide,
        openOrderTracking,
        closeOrderTracking,
        closeAdminAuth,
        isAdminAuthenticated,
        isAdminAuthModalOpen,
        setIsAdminAuthModalOpen,
        openAdminLogin,
        authenticateAdmin,
        logoutAdmin,
        updateAdminPin,
        selectedProductId,
        setSelectedProductId,
        selectedOrderForDetail,
        setSelectedOrderForDetail,
        latestPlacedOrder,
        setLatestPlacedOrder,
        isCartOpen,
        setIsCartOpen,
        isCheckoutOpen,
        setIsCheckoutOpen,
        isQuickViewOpen,
        setIsQuickViewOpen,
        quickViewProduct,
        setQuickViewProduct,
        isSizeGuideOpen,
        setIsSizeGuideOpen,
        isOrderTrackingOpen,
        setIsOrderTrackingOpen,
        adminTab,
        setAdminTab,
        // Filters & Search
        activeCategory,
        setActiveCategory,
        searchQuery,
        setSearchQuery,
        sizeFilter,
        setSizeFilter,
        sortBy,
        setSortBy,
        priceRange,
        setPriceRange,
        // Cart & Coupon values
        cartSubtotal,
        couponDiscount,
        appliedCoupon,
        coupons,
        shippingFee,
        cartTotal,
        totalCartItemCount,
        isFreeShipping,
        // Actions
        applyCoupon,
        removeCoupon,
        addCoupon,
        updateCoupon,
        deleteCoupon,
        toggleCouponStatus,
        addProduct,
        updateProduct,
        deleteProduct,
        updateSizeStock,
        addCategory,
        deleteCategory,
        addToCart,
        updateCartQuantity,
        removeFromCart,
        clearCart,
        toggleWishlist,
        placeOrder,
        updateOrderStatus,
        deleteOrder,
        clearAllOrders,
        updateSettings,
        exportStoreData,
        importStoreData,
        resetToDemoData,
        refreshCloudData: (force = true) => syncWithCloud(force),
        syncAdminOrders: (force = true) => syncAdminOrders(force),
        fetchOrderById: (orderId) => fetchOrderByIdFromCloud(orderId),
        // Toast
        toasts,
        showToast,
        removeToast
      }}
    >
      {children}
    </StoreContext.Provider>
  );
};

export const useStore = () => {
  const context = useContext(StoreContext);
  if (!context) {
    throw new Error("useStore must be used within a StoreProvider");
  }
  return context;
};
