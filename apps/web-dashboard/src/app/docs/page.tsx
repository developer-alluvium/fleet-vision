"use client";

import { useEffect } from "react";

export default function SwaggerDocsPage() {
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css";
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = "https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js";
    script.onload = () => {
      // @ts-ignore
      if (window.SwaggerUIBundle) {
        // @ts-ignore
        window.SwaggerUIBundle({
          url: "/api/openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          filter: true,
          docExpansion: "list",
          defaultModelsExpandDepth: 3,
          displayRequestDuration: true,
          persistAuthorization: true,
          presets: [
            // @ts-ignore
            window.SwaggerUIBundle.presets.apis,
            // @ts-ignore
            window.SwaggerUIBundle.SwaggerUIStandalonePreset,
          ],
        });
      }
    };
    document.body.appendChild(script);
  }, []);

  return (
    <div style={{ backgroundColor: "#ffffff", minHeight: "100vh", padding: "16px" }}>
      <div id="swagger-ui" />
    </div>
  );
}
