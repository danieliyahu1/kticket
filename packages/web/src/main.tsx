import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

// The served shell explains the product to clients that never run JavaScript
// (GitHub issue #1). React owns this container now, so the explanation is
// replaced rather than duplicated.
root.replaceChildren();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
