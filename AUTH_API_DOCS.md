# Authentication API Documentation & Frontend Implementation Plan

## Backend Info

| Property | Value |
|---|---|
| **Backend URL** | `http://localhost:3000` |
| **Frontend URL** | `http://localhost:8080` |
| **Auth Mechanism** | HttpOnly cookies (browser-managed, invisible to JS) |

> **IMPORTANT:** All `fetch` calls from the frontend **must** include `credentials: "include"` so the browser sends/receives cookies cross-origin.

---

## CORS Setup

A CORS middleware has been added at `src/middleware.ts` that:
- Allows origin `http://localhost:8080`
- Sets `Access-Control-Allow-Credentials: true`
- Handles `OPTIONS` preflight requests

No changes are needed on the backend — it is ready to accept requests from port `8080`.

---

## API Endpoints

---

### 1. `POST /api/v1/auth/login`

Authenticates a user. Sets `accessToken` and `refreshToken` as HttpOnly cookies.

**Request:**

```
POST http://localhost:3000/api/v1/auth/login
Content-Type: application/json
```

```json
{
  "email": "admin@myfleet.com",
  "password": "securepassword123"
}
```

**Success Response (200):**

```json
{
  "user": {
    "id": "clxyz...",
    "email": "admin@myfleet.com",
    "organizationId": "clabc...",
    "role": "ADMIN"
  }
}
```

**Response Headers (Set-Cookie):**

| Cookie | HttpOnly | Secure | SameSite | Max-Age |
|---|---|---|---|---|
| `accessToken` (JWT) | ✅ | ✅ (prod) | Lax | 15 minutes |
| `refreshToken` (opaque) | ✅ | ✅ (prod) | Strict | 7 days |

**Error Responses:**

| Status | Body |
|---|---|
| `400` | `{ "error": "Email and password are required" }` |
| `401` | `{ "error": "Invalid email or password" }` |
| `500` | `{ "error": "Internal server error" }` |

---

### 2. `POST /api/v1/auth/refresh`

Issues a new access token and rotates the refresh token. The browser automatically sends the `refreshToken` cookie — **no request body needed**.

**Request:**

```
POST http://localhost:3000/api/v1/auth/refresh
```

_(No body required. The refresh token is read from the cookie.)_

**Success Response (200):**

```json
{
  "success": true
}
```

**Response Headers (Set-Cookie):**

New `accessToken` and `refreshToken` cookies are set (rotation — old refresh token is deleted from the database).

**Error Responses:**

| Status | Body |
|---|---|
| `401` | `{ "error": "Refresh token missing" }` |
| `401` | `{ "error": "Invalid or expired refresh token" }` |
| `500` | `{ "error": "Internal server error" }` |

---

### 3. `POST /api/v1/auth/logout`

Revokes the refresh token server-side and clears both cookies from the browser.

**Request:**

```
POST http://localhost:3000/api/v1/auth/logout
```

_(No body required.)_

**Success Response (200):**

```json
{
  "success": true
}
```

**Response Headers (Set-Cookie):**

Both `accessToken` and `refreshToken` cookies are cleared (`maxAge: 0`).

---

### 4. `GET /api/v1/auth/me`

Retrieves the currently authenticated user's details. Useful for session restoration on page reload.

**Request:**

```
GET http://localhost:3000/api/v1/auth/me
```

_(No body required. Cookies are sent automatically.)_

**Success Response (200):**

```json
{
  "id": "clxyz...",
  "email": "admin@myfleet.com",
  "organizationId": "clabc...",
  "role": "ADMIN"
}
```

**Response Headers (Set-Cookie):**

If the `accessToken` was expired but the `refreshToken` was valid, new `accessToken` and `refreshToken` cookies are set automatically. Otherwise, no cookies are modified.

**Error Responses:**

| Status | Body |
|---|---|
| `401` | `{ "error": "Unauthorized" }` |
| `500` | `{ "error": "Internal server error" }` |

---

## Frontend Implementation Plan

### 1. API Client Setup

Create a centralized API client that:
- Points to `http://localhost:3000`
- Always includes `credentials: "include"`
- Automatically retries with `/refresh` on `401` responses

```typescript
// lib/api.ts

const API_BASE = "http://localhost:3000";

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    credentials: "include", // <-- CRITICAL: sends cookies cross-origin
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  // If 401, try refreshing the token once
  if (response.status === 401) {
    const refreshResponse = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });

    if (refreshResponse.ok) {
      // Retry the original request with the new cookie
      return fetch(`${API_BASE}${url}`, {
        ...options,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
    }

    // Refresh also failed — session expired, redirect to login
    window.location.href = "/login";
  }

  return response;
}

export { fetchWithAuth };
```

### 2. Login Page

```typescript
async function handleLogin(email: string, password: string) {
  const response = await fetch("http://localhost:3000/api/v1/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  const data = await response.json();
  // data.user contains { id, email, organizationId, role }
  // Cookies are automatically set by the browser — no manual storage needed
  return data.user;
}
```

### 3. Using Protected APIs

```typescript
import { fetchWithAuth } from "@/lib/api";

// Example: fetch devices
const response = await fetchWithAuth("/api/v1/devices?orgId=YOUR_ORG_ID");
const data = await response.json();
```

The `fetchWithAuth` wrapper automatically:
- Sends cookies with every request
- Retries once with `/refresh` if the access token has expired
- Redirects to `/login` if the refresh token is also expired

### 4. Logout

```typescript
async function handleLogout() {
  await fetch("http://localhost:3000/api/v1/auth/logout", {
    method: "POST",
    credentials: "include",
  });
  // Redirect to login page
  window.location.href = "/login";
}
```

---

## Auth Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                           LOGIN FLOW                                 │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Frontend :8080             Backend :3000              Database       │
│       │                          │                        │          │
│       │── POST /auth/login ─────>│                        │          │
│       │   {email, password}      │── Validate creds ─────>│          │
│       │                          │<── User found ─────────│          │
│       │                          │── Store refresh token ─>│          │
│       │<── 200 {user}           │                        │          │
│       │    + Set-Cookie:         │                        │          │
│       │      accessToken (15m)   │                        │          │
│       │      refreshToken (7d)   │                        │          │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                     AUTHENTICATED REQUEST                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│       │── GET /devices ─────────>│                        │          │
│       │   (cookies auto-sent)    │── Verify JWT ──────────│          │
│       │<── 200 {data} ──────────│                        │          │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                TOKEN REFRESH (access token expired)                   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│       │── GET /devices ─────────>│                        │          │
│       │<── 401 Unauthorized ─────│                        │          │
│       │                          │                        │          │
│       │── POST /auth/refresh ───>│                        │          │
│       │   (refreshToken cookie)  │── Validate & rotate ──>│          │
│       │<── 200 {success}        │<── New token stored ───│          │
│       │    + Set-Cookie (new)    │                        │          │
│       │                          │                        │          │
│       │── GET /devices (retry) ─>│                        │          │
│       │<── 200 {data} ──────────│                        │          │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                           LOGOUT                                     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│       │── POST /auth/logout ────>│                        │          │
│       │   (refreshToken cookie)  │── Delete token ───────>│          │
│       │<── 200 {success}        │                        │          │
│       │    + Clear cookies       │                        │          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Key Rules for the Frontend Team

1. **Every `fetch` call must use `credentials: "include"`** — without this, cookies won't be sent cross-origin.
2. **Never try to read the tokens from JS** — they are `HttpOnly` and invisible to `document.cookie`.
3. **Don't store tokens in localStorage/sessionStorage** — cookies handle everything.
4. **Handle 401 globally** — use the `fetchWithAuth` wrapper to automatically refresh and retry.
5. **On refresh failure, redirect to `/login`** — the session has fully expired.
