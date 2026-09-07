import React from "react";
import { useStore } from "../../context/StoreContext";

export const CategoryPills = () => {
  const { settings, activeCategory, setActiveCategory, products } = useStore();

  const getCount = (cat) => {
    if (cat === "All") return products.length;
    return products.filter((p) => p.category === cat).length;
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "clamp(6px, 1.5vw, 10px)",
      overflowX: "auto",
      WebkitOverflowScrolling: "touch",
      padding: "6px 2px 14px",
      scrollbarWidth: "none",
      msOverflowStyle: "none",
      width: "100%",
      maxWidth: "100%"
    }}>
      {(settings.categories || []).map((cat) => {
        const isSelected = activeCategory === cat;
        const count = getCount(cat);

        return (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "clamp(7px, 1.5vw, 9px) clamp(14px, 2.5vw, 22px)",
              borderRadius: "var(--radius-full)",
              background: isSelected ? "var(--accent-gold-gradient)" : "rgba(255, 255, 255, 0.95)",
              color: isSelected ? "#ffffff" : "var(--text-primary)",
              border: isSelected ? "1.5px solid var(--border-gold-bright)" : "1px solid var(--border-gold)",
              fontFamily: "var(--font-sans)",
              fontSize: "clamp(0.78rem, 1.8vw, 0.88rem)",
              fontWeight: isSelected ? 700 : 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
              transition: "all var(--transition-fast)",
              boxShadow: isSelected ? "0 6px 20px rgba(192, 127, 70, 0.35)" : "0 2px 6px rgba(45, 20, 28, 0.04)"
            }}
            onMouseEnter={(e) => {
              if (!isSelected) {
                e.currentTarget.style.borderColor = "var(--accent-gold)";
                e.currentTarget.style.color = "var(--accent-gold-dark)";
                e.currentTarget.style.transform = "translateY(-2px)";
                e.currentTarget.style.boxShadow = "var(--shadow-sm)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isSelected) {
                e.currentTarget.style.borderColor = "var(--border-gold)";
                e.currentTarget.style.color = "var(--text-primary)";
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = "0 2px 6px rgba(45, 20, 28, 0.04)";
              }
            }}
          >
            <span>{cat}</span>
            <span style={{
              fontSize: "0.68rem",
              background: isSelected ? "rgba(255, 255, 255, 0.25)" : "var(--bg-secondary)",
              color: isSelected ? "#ffffff" : "var(--accent-gold-dark)",
              padding: "2px 7px",
              borderRadius: "var(--radius-full)",
              fontWeight: 800
            }}>
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
};
