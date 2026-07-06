import express from "express";

const app = express();
const PORT = 8000;

app.get("/health", (_req, res) => {
  res.json({
    status: "online",
    service: "tcp-hardware-listener",
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 tcp-server listening on http://localhost:${PORT}`);
  console.log(`   Health check → http://localhost:${PORT}/health`);
});
