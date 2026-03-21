# Issue: Safari Browser Auto-fill Not Working for HTTP Basic Auth

## Status
Closed (Won't Fix) - Known browser limitation

## Problem Description
Safari browser users report that saved passwords do not auto-fill automatically when accessing the OpenCode Railway deployment at `opencode.tradao.xyz`. The native HTTP Basic Auth dialog appears empty on each visit, requiring manual credential entry.

## Impact
- **Chrome users**: ✅ Auto-fill works correctly
- **Safari users**: ❌ Must manually enter credentials every time

## Root Cause Analysis

### Technical Background
This template uses **HTTP Basic Authentication** (not HTML forms) for security. The browser shows a native credential dialog when accessing the site.

### Browser Differences

**Chrome:**
- ✅ Can capture and auto-fill Basic Auth credentials from native dialogs
- ✅ Supports auto-submit for Basic Auth
- ✅ Stores credentials in Chrome Password Manager with domain matching

**Safari:**
- ⚠️ Can save Basic Auth credentials to macOS Keychain (as "Internet Password")
- ❌ **Does NOT auto-fill credentials** in the native auth dialog
- ❌ Users must manually access Keychain to retrieve credentials
- ❌ iOS Safari: Does not support saving Basic Auth credentials at all

### Evidence from Research

1. **Bitwarden Browser Extension Issue** ([source](https://github.com/bitwarden/browser/issues/1191)):
   > "Safari (Desktop) - Fails Mostly, It does appear to Auto-Detect based on Domain, but does not Auto-Fill"

2. **Apple Stack Exchange** ([source](https://apple.stackexchange.com/questions/319953)):
   > "Safari does not support saving the credentials for basic authentication"

3. **Chrome vs Safari Comparison**:
   | Feature | Chrome | Safari |
   |---------|--------|--------|
   | Save Basic Auth credentials | ✅ Yes | ✅ Yes (to Keychain) |
   | Auto-fill in dialog | ✅ Yes | ❌ No |
   | Auto-submit | ✅ Yes | ❌ No |
   | iOS support | ✅ Yes | ❌ No |

## Attempted Solutions

### Solution 1: Update WWW-Authenticate Realm ✅
**Status:** Implemented

Changed the HTTP Basic Auth realm from generic `"OpenCode"` to domain-specific `"opencode.tradao.xyz"`:

```javascript
// Before
"WWW-Authenticate": 'Basic realm="OpenCode"'

// After  
"WWW-Authenticate": 'Basic realm="opencode.tradao.xyz"'
```

**Impact:** Helps Safari associate the password with the specific domain, but does not enable auto-fill.

### Solution 2: Switch to Form-based Authentication ❌
**Status:** Rejected

**Why rejected:**
- Would require significant architectural changes
- Would need session management (cookies/JWT)
- Increases complexity and attack surface
- HTTP Basic Auth is simpler and more secure for this use case

### Solution 3: URL Embedding (user-side workaround) ⚠️
**Status:** Not recommended

Users can bookmark: `https://opencode:password@opencode.tradao.xyz/`

**Risk:** Credentials exposed in browser history, bookmarks, and server logs

## Workarounds for Safari Users

### Option 1: Use Chrome or Firefox
These browsers have better support for Basic Auth auto-fill.

### Option 2: Manually Add to Safari Passwords
1. Open Safari → Settings → Passwords
2. Click "+" to add new password
3. Enter:
   - Website: `https://opencode.tradao.xyz`
   - Username: `opencode`
   - Password: [your password]
4. Note: This won't auto-fill in the dialog, but makes credentials accessible

### Option 3: Use OpenCode CLI Instead
```bash
# Install locally
npm install -g opencode-ai

# Attach to remote (credentials stored in CLI config)
opencode attach https://opencode.tradao.xyz/ -p YOUR_PASSWORD
```

## Recommendation

**For users:** Use Chrome for the best experience with Basic Auth sites.

**For the project:** This is a Safari design limitation, not a bug we can fix. HTTP Basic Auth is the right choice for this deployment model.

## References

- [Bitwarden Browser Extension Issue #1191](https://github.com/bitwarden/browser/issues/1191)
- [Apple Stack Exchange: iOS Safari Basic Auth](https://apple.stackexchange.com/questions/319953)
- [Apple Stack Exchange: Where Safari stores Basic Auth credentials](https://apple.stackexchange.com/questions/459912)
- [Chrome HTTP Basic Auth Auto-fill Blog](https://blog.camel2243.com/posts/chrome-remember-http-basic-auth/)

## Related Code

The Basic Auth check and realm configuration is in `server.js`:

```javascript
// Line 222-229
if (!checkAuth(req)) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="opencode.tradao.xyz"',
    "Content-Type": "text/plain"
  });
  res.end("Authentication required\n");
  return;
}
```

---

*Last updated: March 21, 2026*
