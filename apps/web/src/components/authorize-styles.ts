// The consent screen's styles, shared by the two surfaces' flows.
//
// They were inline at the bottom of `app/mcp/authorize/page.tsx` until i2 split
// that page into a Convex flow and a PostgreSQL one. Both render the same screen
// to the same person, so the styling is one file rather than two copies that can
// drift while the dark deploy is meant to be comparing them.

import type { CSSProperties } from "react";

export const containerStyle: CSSProperties = {
  maxWidth: 420,
  margin: "80px auto",
  padding: "0 20px",
  fontFamily: "system-ui, -apple-system, sans-serif",
  color: "#111",
};

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: 10,
  boxSizing: "border-box",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: "0.95rem",
};

export const buttonStyle: CSSProperties = {
  marginTop: 8,
  width: "100%",
  padding: 10,
  background: "#111",
  color: "white",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "1rem",
  fontWeight: 500,
};
