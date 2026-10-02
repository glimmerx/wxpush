export const DETAIL_TTL_SECONDS = 3 * 24 * 60 * 60;

export function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

export function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function configuredRecipients(env) {
  const recipients = (env.WX_USERID || '').split('|').map(value => value.trim()).filter(Boolean);
  if (recipients.length < 1 || recipients.length > 10 ||
      recipients.some(value => value.length > 128) ||
      new Set(recipients).size !== recipients.length) {
    throw new Error('invalid_recipient_configuration');
  }
  return recipients;
}
