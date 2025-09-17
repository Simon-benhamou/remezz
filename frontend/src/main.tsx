import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ModeProvider } from "./contexts/ModeContext";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ModeProvider>
    <App />
  </ModeProvider>
);
