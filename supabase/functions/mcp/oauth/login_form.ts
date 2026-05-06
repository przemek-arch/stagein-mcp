export function loginFormHtml(stateToken: string, clientName: string): string {
  // Minimal, brand-aligned, accessible. CSP-compliant inline styles.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to StageIn</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0a0a0a;
    color: #fff;
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .card {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 0;
    padding: 2.5rem;
    max-width: 28rem;
    width: 100%;
  }
  h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 0.5rem; letter-spacing: -0.02em; }
  .sub { color: #888; font-size: 0.875rem; margin-bottom: 1.75rem; }
  .client { color: #C62B0A; font-weight: 600; }
  label { display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: #ccc; }
  input[type="email"] {
    width: 100%;
    padding: 0.75rem 1rem;
    background: #0a0a0a;
    border: 1px solid #2a2a2a;
    color: #fff;
    font-size: 1rem;
    box-sizing: border-box;
    margin-bottom: 1.25rem;
  }
  input[type="email"]:focus { outline: none; border-color: #C62B0A; }
  button {
    width: 100%;
    padding: 0.85rem;
    background: #C62B0A;
    color: #fff;
    border: none;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  button:hover { background: #a62308; }
  .legal { color: #666; font-size: 0.75rem; margin-top: 1.5rem; line-height: 1.5; }
  .legal a { color: #888; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect to StageIn</h1>
    <p class="sub"><span class="client">${escapeHtml(clientName)}</span> wants to access StageIn data on your behalf.</p>
    <form method="POST" action="/oauth/authorize/email">
      <input type="hidden" name="state_token" value="${escapeHtml(stateToken)}">
      <label for="email">Your email address</label>
      <input id="email" type="email" name="email" required autofocus placeholder="you@example.com">
      <button type="submit">Send sign-in link</button>
    </form>
    <p class="legal">
      You'll receive a one-time sign-in link by email.
      By continuing you agree to our <a href="https://stagein.pl/terms">Terms</a> and
      <a href="https://stagein.pl/privacy">Privacy Policy</a>.
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
