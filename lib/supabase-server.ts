The Netlify deploy errored, with the following guidance provided:

Diagnosis

- Relevant log lines: [line 73](#L73), [line 74](#L74) to [line 81](#L81). The TypeScript compiler failed with:
  - [line 74](#L74): "Parameter 'cookiesToSet' implicitly has an 'any' type."
- The failure originates in lib/supabase-server.ts (see repository file: https://github.com/joseromero-crypto/calii-ops-app/blob/main/lib/supabase-server.ts).
- Error type and cause: TypeScript compile error triggered by strict/noImplicitAny rules. The function setAll has an untyped parameter cookiesToSet, so TypeScript treats it as implicit any and the build fails under strict TS settings.

Solution

1. Open lib/supabase-server.ts in your repo: https://github.com/joseromero-crypto/calii-ops-app/blob/main/lib/supabase-server.ts

2. Add an explicit type for the cookiesToSet parameter (preferred: define a small interface for clarity). For example, update the file like this:

```ts
// lib/supabase-server.ts

type CookieToSet = {
  name: string
  value: string
  options?: Record<string, unknown>
}

// ... wherever setAll is defined, change the signature:
setAll(cookiesToSet: CookieToSet[]) {
  try {
    cookiesToSet.forEach(({ name, value, options }) =>
      cookieStore.set(name, value, options)
    )
  } catch (e) {
    // handle or ignore
  }
}
```

- If you prefer a quick, less strict fix you can annotate with any (not recommended long-term):
```ts
setAll(cookiesToSet: any[]) { ... }
```

3. Commit and push the change, then trigger a new build on Netlify. The TypeScript error should be resolved and the Next.js build can complete.

Notes and alternatives
- If you have a type available from a library (e.g., a Cookie type), prefer importing and using that instead of a plain Record<any,any>.
- As a last resort you can relax the TS rule noImplicitAny in tsconfig.json, but fixing the missing type is preferable.

The relevant error logs are:

Line 0: build-image version: ac6eb13fbf000e5c09ad677efd8b7c3c2d0142b6 (noble-new-builds)
Line 1: buildbot version: a15fbca04a781112b2422972fc752cf82dd4cb3a
Line 2: Fetching cached dependencies
Line 3: Failed to fetch cache, continuing with build
Line 4: Starting to prepare the repo for build
Line 5: No cached dependencies found. Cloning fresh repo
Line 6: git clone --filter=blob:none https://github.com/joseromero-crypto/calii-ops-app
Line 7: Preparing Git Reference refs/heads/main
Line 8: Installing dependencies
Line 9: mise ~/.config/mise/config.toml tools: python@3.14.3
Line 10: mise ~/.config/mise/config.toml tools: ruby@3.4.8
Line 11: mise ~/.config/mise/config.toml tools: go@1.26.2
Line 12: v22.22.2 is already installed.
Line 13: Now using node v22.22.2 (npm v10.9.7)
Line 14: Enabling Node.js Corepack
Line 15: No npm workspaces detected
Line 16: Installing npm packages using npm version 10.9.7
Line 17: npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it. Check out lru-cache if you wa
Line 18: npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported
Line 19: npm warn deprecated glob@7.2.3: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, 
Line 20: npm warn deprecated @humanwhocodes/config-array@0.13.0: Use @eslint/config-array instead
Line 21: npm warn deprecated @humanwhocodes/object-schema@2.0.3: Use @eslint/object-schema instead
Line 22: npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
npm warn deprecated glob@10.3.10: O
Line 23: npm warn deprecated tar@7.4.3: Old versions of tar are not supported, and contain widely publicized security vulnerabilities, wh
Line 24: npm warn deprecated eslint@8.57.1: This version is no longer supported. Please see https://eslint.org/version-support for other 
Line 25: npm warn deprecated next@14.2.18: This version has a security vulnerability. Please upgrade to a patched version. See https://ne
Line 26: added 485 packages in 25s
Line 27: npm packages installed
Line 28: Successfully installed dependencies
Line 29: Detected 1 framework(s)
Line 30: "next" at version "14.2.18"
Line 31: Starting build script
Line 32: Section completed: initializing
Line 60: ​
Line 61: $ npm run build
Line 62: > calii-ops-app@0.1.0 build
Line 63: > next build
Line 64: ⚠ No build cache found. Please configure build caching for faster rebuilds. Read more: https://nextjs.org/doc
Line 65:   ▲ Next.js 14.2.18
Line 66:    Creating an optimized production build ...
Line 67: <w> [webpack.cache.PackFileCacheStrategy] Serializing big strings (231kiB) impacts deserialization performance (consider using B
Line 68:  ✓ Compiled successfully
Line 69:    Linting and checking validity of types ...
Line 70: Failed during stage 'building site': Build script returned non-zero exit code: 2
Line 71: Failed to compile.
Line 72: 
Line 73: ./lib/supabase-server.ts:18:16
Line 74: Type error: Parameter 'cookiesToSet' implicitly has an 'any' type.
Line 75:   16 |           return cookieStore.getAll();
Line 76:   17 |         },
Line 77: > 18 |         setAll(cookiesToSet) {
Line 78:      |                ^
Line 79:   19 |           try {
Line 80:   20 |             cookiesToSet.forEach(({ name, value, options }) =>
Line 81:   21 |               cookieStore.set(name, value, options)
Line 82: ​
Line 83: "build.command" failed                                        
Line 84: ────────────────────────────────────────────────────────────────
Line 85: ​
Line 86:   Error message
Line 87:   Command failed with exit code 1: npm run build
Line 88: ​
Line 89:   Error location
Line 90:   In Build command from Netlify app:
Line 91:   npm run build
Line 92: ​
Line 93:   Resolved config
Line 94:   build:
Line 95:     command: npm run build
Line 96:     commandOrigin: ui
Line 97:     environment:
Line 98:       - ANTHROPIC_API_KEY
Line 99:       - ANTHROPIC_MODEL_HAIKU
Line 102:       - NEXT_PUBLIC_SITE_URL
Line 103:       - NEXT_PUBLIC_SUPABASE_ANON_KEY
Line 104:       - NEXT_PUBLIC_SUPABASE_URL
Line 105:       - SUPABASE_SERVICE_ROLE_KEY
Line 106:     publish: /opt/build/repo/.next
Line 107:     publishOrigin: ui
Line 108:   plugins:
Line 109:     - inputs: {}
Line 110:       origin: ui
Line 111:       package: "@netlify/plugin-nextjs"
Line 112: Build failed due to a user error: Build script returned non-zero exit code: 2
Line 113: Failing build: Failed to build site
Line 114: Finished processing build request in 52.726s
