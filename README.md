# Fleet Vision Monorepo

Welcome to the **Fleet Vision** workspace! This is an enterprise-grade full-stack monorepo built using Turborepo, npm Workspaces, Next.js, and Node.js/Express.

---

## 📂 Folder Structure

```
fleet-vision/
├── package.json              # Root workspace configuration & shared scripts
├── turbo.json                # Turborepo task pipeline definition
├── .gitignore                # Global git ignore configurations
├── apps/                     # Application projects
│   ├── web-dashboard/        # Next.js frontend application (App Router, Tailwind CSS v4)
│   │   ├── package.json
│   │   ├── next.config.mjs
│   │   ├── postcss.config.cjs
│   │   ├── tsconfig.json
│   │   └── src/app/
│   │       ├── globals.css   # Tailwind CSS imports
│   │       ├── layout.tsx    # Root layout with dark mode background & meta tags
│   │       └── page.tsx      # Clean minimalist landing page with "System Online" badge
│   └── tcp-server/           # Node.js Express backend service (Telemetry listener)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── server.ts     # Express server exposing GET /health on port 8000
└── packages/                 # Shared libraries/packages (extendable here)
    └── .gitkeep
```

---

## 🚀 How to Run the Project

Follow these steps to run both the frontend dashboard and backend service concurrently in development mode:

### 1. Prerequisite: Node.js
Make sure you have **Node.js** (v18+ recommended) installed.

### 2. Install Dependencies
Run the following command from the root of the `fleet-vision` directory to install all workspaces dependencies:
```bash
npm install
```

### 3. Start Development Servers
Run the single dev command from the root folder:
```bash
npm run dev
```

This launches both applications simultaneously under the hood:
* **Web Dashboard (Next.js):** [http://localhost:3000](http://localhost:3000)
* **TCP Server (Express):** [http://localhost:8000/health](http://localhost:8000/health)

> [!NOTE]
> To ensure seamless cross-platform support (especially on Windows environments where native Turborepo binary wrappers might be blocked or missing system libraries like Visual C++ Redistributable), the root `dev` command uses the `concurrently` package to invoke standard npm workspaces tasks in parallel.

---

## 🛠️ Monorepo Pipeline Config (Turbo Tasks)

Turborepo commands can also be run for compilation and linting:
* `npm run build`: Builds both services.
* `npm run lint`: Performs static analysis.

